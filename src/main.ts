import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, QdrantSyncSettings, QdrantSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";

export default class PostgresSyncPlugin extends Plugin {
  settings!: QdrantSyncSettings;
  sync!: SyncEngine;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.sync = new SyncEngine(this);

    this.addSettingTab(new QdrantSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.sync.schedulePush(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.sync.pushDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.sync.pushRename(oldPath, file);
      }),
    );

    this.addCommand({
      id: "pull-now",
      name: "Pull changes from Postgres now",
      callback: () => {
        void this.sync.pull().then(() => new Notice("Postgres sync: pull complete"));
      },
    });

    if (this.sync.isConfigured()) {
      this.sync.startPulling();
    } else {
      new Notice("Postgres Sync: configure the plugin in Settings to start syncing");
    }
  }

  onunload(): void {
    this.sync.stopPulling();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<QdrantSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
