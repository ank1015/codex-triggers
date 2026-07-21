import type { DesktopApi } from "./shared.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
  getOnboardingStatus: async () =>
    await ipcRenderer.invoke("desktop:get-onboarding-status"),
  completeOnboarding: async () =>
    await ipcRenderer.invoke("desktop:complete-onboarding"),
  getStatus: async () => await ipcRenderer.invoke("desktop:get-status"),
  listTriggers: async () => await ipcRenderer.invoke("desktop:list-triggers"),
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
  setCodexOptions: async (triggerId, options) =>
    await ipcRenderer.invoke("desktop:set-codex-options", triggerId, options),
  deleteTrigger: async (triggerId) =>
    await ipcRenderer.invoke("desktop:delete-trigger", triggerId),
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
