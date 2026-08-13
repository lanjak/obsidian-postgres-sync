import { Notice, TFile, TFolder } from "obsidian";
import type PostgresSyncPlugin from "./main";
import { embed, sha256, pathToId, upsertNote, scrollChangedSince, getNoteByPath } from "./postgrest";
import {
  reconciliationAction,
  SerialTaskQueue,
  SyncFailureStatus,
  SyncWorkQueue,
  isSyncablePath,
  embeddingInput,
  CaseInsensitivePathConflictError,
  findCaseInsensitivePathConflict,
  PriorityTaskQueue,
  type TaskPriority,
  retryDelayMs,
  PathGeneration,
  RemoteChangeGuard,
  RemoteEventSuppressor,
  RemoteContentGuard,
} from "./recovery";

export class SyncEngine {
  private plugin: PostgresSyncPlugin;
  private pushTimers = new Map<string, number>();
  private workQueue = new SyncWorkQueue();
  private serialWrites = new PriorityTaskQueue();
  private serialMaintenance = new SerialTaskQueue();
  private failureStatus = new SyncFailureStatus();
  private pullTimer: number | undefined;
  private reconcileTimer: number | undefined;
  private running = false;
  private reportedCaseConflicts = new Set<string>();
  private pathGenerations = new PathGeneration();
  private remoteChanges = new RemoteChangeGuard();
  private remoteEvents = new RemoteEventSuppressor();
  private remoteContent = new RemoteContentGuard();
  private applyingPull = false;

  constructor(plugin: PostgresSyncPlugin) {
    this.plugin = plugin;
  }

  private get settings() {
    return this.plugin.settings;
  }

  isConfigured(): boolean {
    return Boolean(this.settings.postgrestUrl && this.settings.apiToken && this.settings.embedUrl);
  }

  private shouldSync(path: string): boolean {
    return isSyncablePath(path);
  }

  /** Debounced push - called from vault create/modify events. */
  schedulePush(file: TFile): void {
    if (this.applyingPull || this.remoteChanges.has(file.path)) return;
    void this.schedulePushOnce(file);
  }

  private async schedulePushOnce(file: TFile): Promise<void> {
    const content = await this.plugin.app.vault.read(file).catch(() => undefined);
    if (content !== undefined && this.remoteContent.consumeIfMatching(file.path, content)) return;
    if (!this.isConfigured() || !this.shouldSync(file.path) || this.remoteChanges.has(file.path)) return;
    this.pathGenerations.next(file.path);
    this.workQueue.markDirty(file.path);
    this.schedulePath(file.path, 2_000, "high");
  }

  private schedulePath(path: string, delayMs: number, priority: TaskPriority = "low"): void {
    if (!this.running) return;
    const existing = this.pushTimers.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(path);
      void this.serialWrites.run(() => this.pushPath(path), priority);
    }, delayMs);
    this.pushTimers.set(path, timer);
  }

  private async pushPath(path: string): Promise<void> {
    if (!this.workQueue.begin(path)) return;
    let success = false;
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !this.shouldSync(file.path)) {
        success = true;
        return;
      }

      const content = await this.plugin.app.vault.read(file);
      const contentHash = await sha256(content);

      const remote = await getNoteByPath(this.settings, file.path);
      if (remote && remote.payload.contentHash === contentHash && !remote.payload.deleted) {
        success = true;
        return; // no real change (e.g. our own pull-triggered write firing a modify event)
      }

      if (remote && remote.payload.mtime >= file.stat.mtime) {
        await this.applyRemoteChange(remote.payload);
        success = true;
        return;
      }

      const vector = await embed(this.settings, embeddingInput(content), "search_document");
      const id = await pathToId(file.path);
      await upsertNote(this.settings, id, vector, {
        path: file.path,
        content,
        contentHash,
        // Use the accepted write time so devices whose pull cursor is already
        // newer than an old local file still discover this new database row.
        mtime: Date.now(),
        size: content.length,
        deleted: false,
      });
      success = true;
    } catch (e) {
      console.error("postgres-sync: push failed for", path, e);
    } finally {
      const result = this.workQueue.finish(path, success);
      if (!success) {
        const status = this.failureStatus.failed(path);
        if (status.notify) {
          new Notice("Postgres sync paused some changes. Retrying in the background.", 8_000);
        }
      } else if (result.recovered) {
        const status = this.failureStatus.succeeded(path);
        if (status.notify) {
          new Notice(`Postgres sync recovered ${status.recovered} pending change${status.recovered === 1 ? "" : "s"}.`, 5_000);
        }
      }
      if (result.shouldSchedule) this.schedulePath(path, result.delayMs);
    }
  }

  async pushDelete(path: string): Promise<void> {
    if (this.remoteEvents.consume(path)) return;
    if (!this.isConfigured() || !this.shouldSync(path) || this.remoteChanges.has(path)) return;
    const timer = this.pushTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.pushTimers.delete(path);
    }
    this.workQueue.clear(path);
    const generation = this.pathGenerations.next(path);
    await this.serialWrites.run(() => this.pushDeleteOnce(path, 0, generation), "high");
  }

  private async pushDeleteOnce(path: string, failedAttempts: number, generation: number): Promise<void> {
    if (!this.pathGenerations.isCurrent(path, generation)) return;
    try {
      const id = await pathToId(path);
      await upsertNote(this.settings, id, null, {
        path,
        content: "",
        contentHash: "",
        mtime: Date.now(),
        size: 0,
        deleted: true,
      });
      const status = this.failureStatus.succeeded(path);
      if (status.notify) {
        new Notice(`Postgres sync recovered ${status.recovered} pending change${status.recovered === 1 ? "" : "s"}.`, 5_000);
      }
    } catch (e) {
      if (!this.pathGenerations.isCurrent(path, generation)) return;
      console.error("postgres-sync: delete tombstone failed for", path, e);
      const status = this.failureStatus.failed(path);
      if (status.notify) {
        new Notice("Postgres sync paused some changes. Retrying in the background.", 8_000);
      }
      this.scheduleDeleteRetry(path, failedAttempts + 1, generation);
    }
  }

  private scheduleDeleteRetry(path: string, failedAttempts: number, generation: number): void {
    if (!this.running || !this.pathGenerations.isCurrent(path, generation)) return;
    const existing = this.pushTimers.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(path);
      void this.serialWrites.run(() => this.pushDeleteOnce(path, failedAttempts, generation), "low");
    }, retryDelayMs(failedAttempts));
    this.pushTimers.set(path, timer);
  }

  async pushRename(oldPath: string, file: TFile): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.shouldSync(oldPath)) await this.pushDelete(oldPath);
    if (this.shouldSync(file.path)) this.schedulePush(file);
  }

  startPulling(): void {
    this.stopPulling();
    this.running = true;
    const intervalMs = Math.max(5, this.settings.pullIntervalSeconds) * 1000;
    this.pullTimer = window.setInterval(() => void this.pull(), intervalMs);
    const reconcileMs = Math.max(300_000, intervalMs * 10);
    this.reconcileTimer = window.setInterval(() => void this.reconcile(), reconcileMs);
    void this.pull().then(() => this.reconcile());
  }

  stopPulling(): void {
    this.running = false;
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    if (this.reconcileTimer) window.clearInterval(this.reconcileTimer);
    this.pullTimer = undefined;
    this.reconcileTimer = undefined;
    for (const timer of this.pushTimers.values()) window.clearTimeout(timer);
    this.pushTimers.clear();
  }

  reconcile(): Promise<void> {
    return this.serialMaintenance.run(() => this.reconcileOnce());
  }

  private async reconcileOnce(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const { rows: remoteRows } = await scrollChangedSince(this.settings, 0);
      const remoteByPath = new Map(remoteRows.map((row) => [row.payload.path, row]));
      const localPaths = new Set<string>();

      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if (!this.shouldSync(file.path)) continue;
        localPaths.add(file.path);
        const content = await this.plugin.app.vault.read(file);
        const contentHash = await sha256(content);
        const remote = remoteByPath.get(file.path);
        const action = reconciliationAction(
          { contentHash, mtime: file.stat.mtime },
          remote
            ? {
                contentHash: remote.payload.contentHash,
                mtime: remote.payload.mtime,
                deleted: remote.payload.deleted,
              }
            : undefined,
        );

        if (action === "push") {
          this.pathGenerations.next(file.path);
          this.workQueue.markDirty(file.path);
          this.schedulePath(file.path, 0, "low");
        } else if (action === "pull" && remote) {
          await this.applyRemoteChange(remote.payload);
        }
      }

      for (const row of remoteRows) {
        if (this.shouldSync(row.payload.path) && !localPaths.has(row.payload.path)) {
          try {
            await this.applyRemoteChange(row.payload);
          } catch (error) {
            if (error instanceof CaseInsensitivePathConflictError) {
              this.reportCaseConflict(error);
              continue;
            }
            throw error;
          }
        }
      }
    } catch (e) {
      console.error("postgres-sync: reconciliation failed", e);
    }
  }

  pull(): Promise<void> {
    return this.serialMaintenance.run(async () => {
      this.applyingPull = true;
      try {
        await this.pullOnce();
      } finally {
        this.applyingPull = false;
      }
    });
  }

  private async pullOnce(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const changed = await scrollChangedSince(this.settings, this.settings.lastSyncRevision);
      if (changed.highWaterRevision <= this.settings.lastSyncRevision) return;

      for (const row of changed.rows) {
        if (this.shouldSync(row.payload.path)) {
          try {
            await this.applyRemoteChange(row.payload);
          } catch (error) {
            if (error instanceof CaseInsensitivePathConflictError) {
              this.reportCaseConflict(error);
            } else {
              throw error;
            }
          }
        }
      }
      this.settings.lastSyncRevision = changed.highWaterRevision;
      await this.plugin.saveSettings();
    } catch (e) {
      console.error("postgres-sync: pull failed", e);
    }
  }

  private async applyRemoteChange(payload: {
    path: string;
    content: string;
    mtime: number;
    deleted: boolean;
  }): Promise<void> {
    await this.remoteChanges.run(payload.path, () => this.applyRemoteChangeOnce(payload));
  }

  private async applyRemoteChangeOnce(payload: {
    path: string;
    content: string;
    mtime: number;
    deleted: boolean;
  }): Promise<void> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(payload.path);

    if (payload.deleted) {
      if (existing instanceof TFile && existing.stat.mtime <= payload.mtime) {
        this.remoteEvents.prepare(payload.path);
        try {
          await this.plugin.app.fileManager.trashFile(existing);
        } catch (error) {
          this.remoteEvents.discard(payload.path);
          throw error;
        }
      }
      return;
    }

    if (existing instanceof TFile) {
      if (existing.stat.mtime > payload.mtime) return; // local edit is newer - last-write-wins keeps it
      const localContent = await vault.read(existing);
      if (localContent === payload.content) return;
      this.remoteContent.prepare(payload.path, payload.content);
      try {
        await vault.modify(existing, payload.content);
      } catch (error) {
        this.remoteContent.discard(payload.path);
        throw error;
      }
    } else {
      const conflict = findCaseInsensitivePathConflict(
        payload.path,
        vault.getFiles().map((file) => file.path),
      );
      if (conflict) throw new CaseInsensitivePathConflictError(payload.path, conflict);
      await this.ensureFolder(payload.path);
      this.remoteContent.prepare(payload.path, payload.content);
      try {
        await vault.create(payload.path, payload.content);
      } catch (error) {
        this.remoteContent.discard(payload.path);
        throw error;
      }
    }
  }

  private reportCaseConflict(error: CaseInsensitivePathConflictError): void {
    if (this.reportedCaseConflicts.has(error.remotePath)) return;
    this.reportedCaseConflicts.add(error.remotePath);
    console.warn("postgres-sync: skipped case-insensitive path conflict", error.remotePath, error.localPath);
    if (this.reportedCaseConflicts.size === 1) {
      new Notice("Postgres sync skipped one or more paths that differ only by letter case. See the console for details.", 10_000);
    }
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    if (parts.length === 0) return;
    const vault = this.plugin.app.vault;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = vault.getAbstractFileByPath(current);
      if (!(existing instanceof TFolder)) {
        await vault.createFolder(current).catch(() => undefined);
      }
    }
  }
}
