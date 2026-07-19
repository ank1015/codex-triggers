import type { DesktopApi } from "./shared.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
  getStatus: async () => await ipcRenderer.invoke("desktop:get-status"),
  listActiveTriggers: async () =>
    await ipcRenderer.invoke("desktop:list-active-triggers"),
  openCodexNewChat: async () =>
    await ipcRenderer.invoke("desktop:open-codex-new-chat"),
  getWebhookTunnelSettings: async () =>
    await ipcRenderer.invoke("desktop:get-webhook-tunnel-settings"),
  setWebhookTunnelEnabled: async (enabled) =>
    await ipcRenderer.invoke("desktop:set-webhook-tunnel-enabled", enabled),
};

contextBridge.exposeInMainWorld("desktop", api);
