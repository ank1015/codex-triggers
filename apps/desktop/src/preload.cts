import type { DesktopApi } from "./shared.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
  getStatus: async () => await ipcRenderer.invoke("desktop:get-status"),
  listActiveTriggers: async () =>
    await ipcRenderer.invoke("desktop:list-active-triggers"),
  getTriggerPage: async (triggerId) =>
    await ipcRenderer.invoke("desktop:get-trigger-page", triggerId),
  setTriggerEnabled: async (triggerId, enabled) =>
    await ipcRenderer.invoke("desktop:set-trigger-enabled", triggerId, enabled),
  setCodexShowInCodex: async (triggerId, showInCodex) =>
    await ipcRenderer.invoke(
      "desktop:set-codex-show-in-codex",
      triggerId,
      showInCodex,
    ),
  openCodexNewChat: async () =>
    await ipcRenderer.invoke("desktop:open-codex-new-chat"),
  openCodexThread: async (threadId) =>
    await ipcRenderer.invoke("desktop:open-codex-thread", threadId),
  getWebhookTunnelSettings: async () =>
    await ipcRenderer.invoke("desktop:get-webhook-tunnel-settings"),
  setWebhookTunnelEnabled: async (enabled) =>
    await ipcRenderer.invoke("desktop:set-webhook-tunnel-enabled", enabled),
};

contextBridge.exposeInMainWorld("desktop", api);
