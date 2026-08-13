import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type QdrantSyncPlugin from "./main";

export interface QdrantSyncSettings {
  postgrestUrl: string;
  apiToken: string;
  embedUrl: string;
  embedApiKey: string;
  pullIntervalSeconds: number;
  lastSyncCursor: number;
  lastSyncRevision: number;
}

export const DEFAULT_SETTINGS: QdrantSyncSettings = {
  postgrestUrl: "",
  apiToken: "",
  embedUrl: "",
  embedApiKey: "",
  pullIntervalSeconds: 30,
  lastSyncCursor: 0,
  lastSyncRevision: 0,
};

export class QdrantSyncSettingTab extends PluginSettingTab {
  plugin: QdrantSyncPlugin;

  constructor(app: App, plugin: QdrantSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override setControlValue(key: string, value: unknown): void | Promise<void> {
    if ((key === "postgrestUrl" || key === "embedUrl") && typeof value === "string") {
      value = value.replace(/\/+$/, "");
    }
    return super.setControlValue(key, value);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "PostgREST URL",
        desc: "Your PostgREST instance in front of Postgres, e.g. https://postgrest.example.com",
        control: { type: "text", key: "postgrestUrl" },
      },
      {
        name: "API key",
        desc: "Sent as an X-Api-Key header, checked by your PostgREST pre-request auth function - see the project repo's sql/schema.sql for the setup",
        control: { type: "text", key: "apiToken" },
      },
      {
        name: "Embedding server URL",
        desc: "llama.cpp server with --embedding enabled, e.g. https://embed.example.com",
        control: { type: "text", key: "embedUrl" },
      },
      {
        name: "Embed API key",
        desc: "Optional - only needed if the embedding server requires auth. Sent as an Authorization: Bearer header.",
        control: { type: "text", key: "embedApiKey" },
      },
      {
        name: "Pull interval (seconds)",
        desc: "How often to poll Postgres for remote changes",
        control: { type: "number", key: "pullIntervalSeconds", min: 5 },
      },
      {
        name: "Force full resync",
        desc: "Reset the sync cursor to 0 and re-pull everything on next interval - use if this device missed changes",
        render: (setting) => {
          setting.addButton((btn) =>
            btn.setButtonText("Reset Cursor").onClick(async () => {
              this.plugin.settings.lastSyncCursor = 0;
              this.plugin.settings.lastSyncRevision = 0;
              await this.plugin.saveSettings();
            }),
          );
        },
      },
    ];
  }
}
