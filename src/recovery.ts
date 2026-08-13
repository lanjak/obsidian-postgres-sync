const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 300_000;

const SYNC_ROOT_EXCLUDE = /^\./;
const MAX_EMBED_CHARS = 4_000;

export function isSyncablePath(path: string): boolean {
  return path.endsWith(".md") && !SYNC_ROOT_EXCLUDE.test(path);
}

/** Keeps embedding requests below common 2K-token local model limits. */
export function embeddingInput(content: string): string {
  return content.slice(0, MAX_EMBED_CHARS);
}

export function findCaseInsensitivePathConflict(path: string, existingPaths: string[]): string | undefined {
  const folded = path.toLocaleLowerCase("en-US");
  return existingPaths.find(
    (existingPath) => existingPath !== path && existingPath.toLocaleLowerCase("en-US") === folded,
  );
}

export class CaseInsensitivePathConflictError extends Error {
  constructor(
    readonly remotePath: string,
    readonly localPath: string,
  ) {
    super(`Cannot create ${remotePath} because this device already has ${localPath}`);
    this.name = "CaseInsensitivePathConflictError";
  }
}

export class PathGeneration {
  private values = new Map<string, number>();

  next(path: string): number {
    const generation = (this.values.get(path) ?? 0) + 1;
    this.values.set(path, generation);
    return generation;
  }

  isCurrent(path: string, generation: number): boolean {
    return this.values.get(path) === generation;
  }
}

/** Prevents vault events emitted by a remote apply from being pushed back to the server. */
export class RemoteChangeGuard {
  private paths = new Set<string>();

  has(path: string): boolean {
    return this.paths.has(path);
  }

  async run<T>(path: string, task: () => Promise<T>): Promise<T> {
    this.paths.add(path);
    try {
      return await task();
    } finally {
      this.paths.delete(path);
    }
  }
}

/** Consumes the one vault event that Obsidian emits after a remote file operation. */
export class RemoteEventSuppressor {
  private paths = new Set<string>();

  prepare(path: string): void {
    this.paths.add(path);
  }

  consume(path: string): boolean {
    if (!this.paths.has(path)) return false;
    this.paths.delete(path);
    return true;
  }

  discard(path: string): void {
    this.paths.delete(path);
  }
}

/** Suppresses a delayed create/modify event only while content still matches the pull. */
export class RemoteContentGuard {
  private content = new Map<string, string>();

  prepare(path: string, content: string): void {
    this.content.set(path, content);
  }

  consumeIfMatching(path: string, content: string): boolean {
    const expected = this.content.get(path);
    if (expected === undefined) return false;
    if (expected === content) return true;
    this.content.delete(path);
    return false;
  }

  discard(path: string): void {
    this.content.delete(path);
  }
}

export function retryDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, failedAttempts - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

export function revisionPageQuery(afterRevision: number, highWaterRevision: number, limit: number): string {
  return `sync_revision=gt.${afterRevision}&sync_revision=lte.${highWaterRevision}&order=sync_revision.asc&limit=${limit}&select=id,sync_revision,path,content,content_hash,mtime,size,deleted`;
}

interface RevisionRow {
  syncRevision: number;
}

export async function collectRevisionPages<T extends RevisionRow>(
  sinceRevision: number,
  highWaterRevision: number,
  limit: number,
  fetchPage: (afterRevision: number, highWaterRevision: number, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let afterRevision = sinceRevision;
  while (afterRevision < highWaterRevision) {
    const page = await fetchPage(afterRevision, highWaterRevision, limit);
    if (page.length === 0) break;
    rows.push(...page);
    const nextRevision = page[page.length - 1].syncRevision;
    if (nextRevision <= afterRevision) throw new Error("Revision page did not advance");
    afterRevision = nextRevision;
    if (page.length < limit) break;
  }
  return rows;
}

/** Serializes network-heavy recovery work so a vault scan cannot overload mobile or the embedding server. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type TaskPriority = "high" | "low";

interface QueuedTask {
  execute: () => Promise<void>;
}

/** Runs one task at a time while allowing user edits to pass queued background recovery work. */
export class PriorityTaskQueue {
  private high: QueuedTask[] = [];
  private low: QueuedTask[] = [];
  private running = false;

  run<T>(task: () => Promise<T>, priority: TaskPriority): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        execute: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      };
      // User-facing vault events are newest-first so a startup burst cannot
      // delay the note the user just edited behind hundreds of stale events.
      if (priority === "high") this.high.unshift(queued);
      else this.low.push(queued);
    });
    void this.drain();
    return result;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.high.shift() ?? this.low.shift();
        if (!next) return;
        await next.execute();
      }
    } finally {
      this.running = false;
    }
  }
}

export interface FailureStatusResult {
  notify: boolean;
  pending: number;
}

export interface RecoveryStatusResult extends FailureStatusResult {
  recovered: number;
}

/** Aggregates per-path failures into one session-level failure and recovery transition. */
export class SyncFailureStatus {
  private failedPaths = new Set<string>();
  private recoveredCount = 0;

  failed(path: string): FailureStatusResult {
    const wasHealthy = this.failedPaths.size === 0;
    this.failedPaths.add(path);
    return { notify: wasHealthy, pending: this.failedPaths.size };
  }

  succeeded(path: string): RecoveryStatusResult {
    if (this.failedPaths.delete(path)) this.recoveredCount += 1;
    const notify = this.failedPaths.size === 0 && this.recoveredCount > 0;
    const result = { notify, pending: this.failedPaths.size, recovered: this.recoveredCount };
    if (notify) this.recoveredCount = 0;
    return result;
  }
}

export interface WorkResult {
  shouldSchedule: boolean;
  delayMs: number;
  failedAttempts: number;
  recovered: boolean;
}

/** Tracks dirty paths separately from active writes so edits cannot disappear during an in-flight request. */
export class SyncWorkQueue {
  private dirty = new Set<string>();
  private active = new Set<string>();
  private failedAttempts = new Map<string, number>();

  markDirty(path: string): void {
    this.dirty.add(path);
  }

  begin(path: string): boolean {
    if (this.active.has(path) || !this.dirty.has(path)) return false;
    this.dirty.delete(path);
    this.active.add(path);
    return true;
  }

  finish(path: string, success: boolean): WorkResult {
    this.active.delete(path);
    const previousFailures = this.failedAttempts.get(path) ?? 0;

    if (success) {
      this.failedAttempts.delete(path);
      return {
        shouldSchedule: this.dirty.has(path),
        delayMs: 0,
        failedAttempts: 0,
        recovered: previousFailures > 0,
      };
    }

    const failures = previousFailures + 1;
    this.failedAttempts.set(path, failures);
    this.dirty.add(path);
    return {
      shouldSchedule: true,
      delayMs: retryDelayMs(failures),
      failedAttempts: failures,
      recovered: false,
    };
  }

  isDirty(path: string): boolean {
    return this.dirty.has(path);
  }

  clear(path: string): void {
    this.dirty.delete(path);
    this.active.delete(path);
    this.failedAttempts.delete(path);
  }
}

export interface ReconciliationLocal {
  contentHash: string;
  mtime: number;
}

export interface ReconciliationRemote {
  contentHash: string;
  mtime: number;
  deleted: boolean;
}

export type ReconciliationAction = "none" | "push" | "pull";

/** Uses modification time only when hashes differ; equal times resolve to the remote row. */
export function reconciliationAction(
  local: ReconciliationLocal,
  remote: ReconciliationRemote | undefined,
): ReconciliationAction {
  if (!remote) return "push";
  if (!remote.deleted && local.contentHash === remote.contentHash) return "none";
  return local.mtime > remote.mtime ? "push" : "pull";
}
