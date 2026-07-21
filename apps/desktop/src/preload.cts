import type { DesktopApi } from "./shared.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
  getOnboardingStatus: async () =>
    await ipcRenderer.invoke("desktop:get-onboarding-status"),
  completeOnboarding: async () =>
    await ipcRenderer.invoke("desktop:complete-onboarding"),
  getMacosNotificationPermission: async () =>
    await ipcRenderer.invoke("desktop:get-macos-notification-permission"),
  requestMacosNotificationPermission: async () =>
    await ipcRenderer.invoke("desktop:request-macos-notification-permission"),
  getStatus: async () => await ipcRenderer.invoke("desktop:get-status"),
  listTriggers: async () => await ipcRenderer.invoke("desktop:list-triggers"),
  getTriggerPage: async (triggerId) =>
    await ipcRenderer.invoke("desktop:get-trigger-page", triggerId),
  setTriggerEnabled: async (triggerId, enabled) =>
    await ipcRenderer.invoke("desktop:set-trigger-enabled", triggerId, enabled),
  setMacosNotificationsEnabled: async (triggerId, enabled) =>
    await ipcRenderer.invoke(
      "desktop:set-macos-notifications-enabled",
      triggerId,
      enabled,
    ),
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
  openCodexNewChat: async (prompt) =>
    await ipcRenderer.invoke("desktop:open-codex-new-chat", prompt),
  openCodexThread: async (threadId) =>
    await ipcRenderer.invoke("desktop:open-codex-thread", threadId),
  openMacosNotificationSettings: async () =>
    await ipcRenderer.invoke("desktop:open-macos-notification-settings"),
  getWebhookTunnelSettings: async () =>
    await ipcRenderer.invoke("desktop:get-webhook-tunnel-settings"),
  setWebhookTunnelEnabled: async (enabled) =>
    await ipcRenderer.invoke("desktop:set-webhook-tunnel-enabled", enabled),
  getPendingTriggerNavigation: async (expectedTriggerId) =>
    await ipcRenderer.invoke(
      "desktop:get-pending-trigger-navigation",
      expectedTriggerId,
    ),
  onOpenTrigger: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, trigger: unknown) => {
      listener(trigger as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on("desktop:open-trigger", handler);
    return () => ipcRenderer.removeListener("desktop:open-trigger", handler);
  },
};

contextBridge.exposeInMainWorld("desktop", api);
