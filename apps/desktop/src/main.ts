import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  loadConfig,
  TriggerServer,
  type WebhookTunnel,
  type WebhookTunnelStatus,
} from "@codexmaxxing/trigger";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import type { ActiveTrigger, DesktopStatus } from "./shared.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const smokeTest = process.env.TRIGGER_DESKTOP_SMOKE_TEST === "1";
const execFileAsync = promisify(execFile);

if (smokeTest) {
  app.setPath("userData", join(tmpdir(), `codex-triggers-smoke-${process.pid}`));
}

let window: BrowserWindow | null = null;
let triggerServer: TriggerServer | null = null;
let shutdownComplete = false;
let exitCode = 0;
let lastOpenedExternalUrl: string | null = null;
const windowLoads = new WeakMap<BrowserWindow, Promise<void>>();

function createWindow(show = true): BrowserWindow {
  const created = new BrowserWindow({
    show,
    width: 780,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: "Codex Triggers",
    backgroundColor: "#000000",
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const loading = created.loadFile(join(directory, "index.html"));
  windowLoads.set(created, loading);
  if (show) {
    void loading.catch((error: unknown) =>
      console.error("Trigger Desktop UI failed to load", error),
    );
  }
  created.on("closed", () => {
    window = null;
  });
  return created;
}

function desktopConfig() {
  const environmentConfig = loadConfig();
  const hasConfiguredDataDir = Boolean(process.env.TRIGGER_DATA_DIR?.trim());
  return loadConfig({
    dataDir: hasConfiguredDataDir
      ? environmentConfig.dataDir
      : join(app.getPath("userData"), "trigger"),
    ...(smokeTest ? { controlPort: 0, publicPort: 0 } : {}),
  });
}

function currentStatus(server: TriggerServer): DesktopStatus {
  const addresses = server.addresses;
  if (!addresses) throw new Error("Trigger backend is not running");
  return {
    status: "running",
    controlOrigin: addresses.control.origin,
    webhookOrigin: addresses.public.origin,
    dataDir: server.config.dataDir,
    deliveryServices: server.system.delivery.registry
      .list()
      .map(({ type }) => type),
  };
}

function listActiveTriggers(server: TriggerServer): ActiveTrigger[] {
  return server.system.database
    .listTriggers()
    .filter(({ enabled }) => enabled)
    .map(({ id, name, kind }) => ({ id, name, kind }));
}

function createSmokeWebhookTunnel(): WebhookTunnel {
  let enabled = false;
  const status = (): WebhookTunnelStatus => ({
    enabled,
    publicWebhookUrl: enabled
      ? "https://smoke.example.ts.net/codex-triggers"
      : null,
    error: null,
  });
  return {
    async status() {
      return status();
    },
    async setEnabled(nextEnabled) {
      enabled = nextEnabled;
      return status();
    },
  };
}

async function openCodexNewChat(): Promise<void> {
  const url = "codex://threads/new";
  lastOpenedExternalUrl = url;
  if (!smokeTest) await shell.openExternal(url);
}

async function runSmokeTest(server: TriggerServer): Promise<void> {
  const status = currentStatus(server);
  const healthUrl = `${status.controlOrigin}/health`;
  const [healthResponse, servicesResponse] = await Promise.all([
    fetch(healthUrl),
    fetch(`${status.controlOrigin}/v1/delivery-services`),
  ]);
  if (!healthResponse.ok || !servicesResponse.ok) {
    throw new Error(
      `Desktop backend smoke test failed (${healthResponse.status}, ${servicesResponse.status})`,
    );
  }
  const services = (await servicesResponse.json()) as {
    services: Array<{ type: string }>;
  };
  const serviceTypes = services.services.map(({ type }) => type);
  if (
    serviceTypes.length !== 1 ||
    serviceTypes[0] !== "codex-app-server"
  ) {
    throw new Error(
      `Unexpected Desktop Delivery Services: ${serviceTypes.join(", ")}`,
    );
  }
  await execFileAsync(
    process.execPath,
    [
      "-e",
      `fetch(${JSON.stringify(healthUrl)}).then(response => { if (!response.ok) process.exit(1) })`,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  window = createWindow(false);
  await windowLoads.get(window);
  const renderedHeader = (await window.webContents.executeJavaScript(
    `({
      logo: document.querySelector(".app-logo")?.getAttribute("src"),
      settingsLabel: document.querySelector(".settings-button")?.getAttribute("aria-label"),
      sectionTitle: document.querySelector(".active-triggers-title")?.textContent,
      addLabel: document.querySelector(".add-trigger-card")?.getAttribute("aria-label"),
    })`,
  )) as {
    logo?: string;
    settingsLabel?: string;
    sectionTitle?: string;
    addLabel?: string;
  };
  if (
    renderedHeader.logo !== "./logo.jpg" ||
    renderedHeader.settingsLabel !== "Settings" ||
    renderedHeader.sectionTitle !== "Active Triggers" ||
    renderedHeader.addLabel !== "Create a Trigger"
  ) {
    throw new Error(
      `Desktop UI rendered an unexpected header: ${JSON.stringify(renderedHeader)}`,
    );
  }

  const createPage = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".add-trigger-card")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return {
        title: document.querySelector(".create-trigger-title")?.textContent,
        backLabel: document.querySelector(".header-icon-button")?.getAttribute("aria-label"),
        message: document.querySelector(".codex-skill-card p")?.textContent,
        action: document.querySelector(".ask-codex-button")?.textContent,
        section: document.querySelector(".pre-made-title")?.textContent,
      };
    })()`,
  )) as {
    title?: string;
    backLabel?: string;
    message?: string;
    action?: string;
    section?: string;
  };
  if (
    createPage.title !== "Create Trigger" ||
    createPage.backLabel !== "Go back" ||
    createPage.message !==
      "Create ANY trigger by just asking Codex for it using the official skill" ||
    createPage.action !== "Ask Codex" ||
    createPage.section !== "Pre-Made Triggers"
  ) {
    throw new Error(
      `Desktop UI rendered an unexpected create page: ${JSON.stringify(createPage)}`,
    );
  }

  await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".ask-codex-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
    })()`,
  );
  if (lastOpenedExternalUrl !== "codex://threads/new") {
    throw new Error(
      `Ask Codex opened an unexpected URL: ${lastOpenedExternalUrl}`,
    );
  }

  const returnedTitle = await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".header-icon-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return document.querySelector(".active-triggers-title")?.textContent;
    })()`,
  );
  if (returnedTitle !== "Active Triggers") {
    throw new Error(`Desktop UI back navigation failed: ${returnedTitle}`);
  }

  const settingsPage = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".settings-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const initial = {
        title: document.querySelector(".settings-title")?.textContent,
        setting: document.querySelector(".setting-copy h2")?.textContent,
        checked: document.querySelector(".toggle-switch")?.getAttribute("aria-checked"),
      };
      document.querySelector(".toggle-switch")?.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        ...initial,
        enabled: document.querySelector(".toggle-switch")?.getAttribute("aria-checked"),
        publicWebhookUrl: document.querySelector(".public-webhook-url")?.textContent,
      };
    })()`,
  )) as {
    title?: string;
    setting?: string;
    checked?: string;
    enabled?: string;
    publicWebhookUrl?: string;
  };
  if (
    settingsPage.title !== "Settings" ||
    settingsPage.setting !== "Tailscale tunnel for webhooks" ||
    settingsPage.checked !== "false" ||
    settingsPage.enabled !== "true" ||
    settingsPage.publicWebhookUrl !==
      "https://smoke.example.ts.net/codex-triggers"
  ) {
    throw new Error(
      `Desktop UI rendered unexpected webhook settings: ${JSON.stringify(settingsPage)}`,
    );
  }
  window.close();
  console.log(
    `Trigger Desktop smoke test passed (${status.controlOrigin}, ${status.webhookOrigin})`,
  );
}

async function startDesktop(): Promise<void> {
  triggerServer = new TriggerServer(desktopConfig(), {
    builtInDeliveryServices: ["codex-app-server"],
    ...(smokeTest ? { webhookTunnel: createSmokeWebhookTunnel() } : {}),
  });
  const addresses = await triggerServer.start();
  console.log(`Trigger control API listening on ${addresses.control.origin}`);
  console.log(`Trigger webhook gateway listening on ${addresses.public.origin}`);

  ipcMain.handle("desktop:get-status", () => currentStatus(triggerServer!));
  ipcMain.handle("desktop:list-active-triggers", () =>
    listActiveTriggers(triggerServer!),
  );
  ipcMain.handle("desktop:open-codex-new-chat", openCodexNewChat);
  ipcMain.handle("desktop:get-webhook-tunnel-settings", () =>
    triggerServer!.system.getWebhookTunnelStatus(),
  );
  ipcMain.handle(
    "desktop:set-webhook-tunnel-enabled",
    (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      return triggerServer!.system.setWebhookTunnelEnabled(enabled);
    },
  );

  if (smokeTest) {
    await runSmokeTest(triggerServer);
    app.quit();
    return;
  }
  window = createWindow();
}

async function stopDesktop(): Promise<void> {
  if (triggerServer) await triggerServer.stop();
  triggerServer = null;
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) window = createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on("activate", () => {
    if (!window && !smokeTest) window = createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void stopDesktop()
      .catch((error: unknown) => {
        exitCode = 1;
        console.error("Failed to stop Trigger Desktop", error);
      })
      .finally(() => {
        shutdownComplete = true;
        process.exitCode = exitCode;
        app.quit();
      });
  });

  process.once("SIGINT", () => app.quit());
  process.once("SIGTERM", () => app.quit());

  void app
    .whenReady()
    .then(startDesktop)
    .catch((error: unknown) => {
      exitCode = 1;
      console.error("Trigger Desktop failed to start", error);
      if (!smokeTest) {
        dialog.showErrorBox(
          "Trigger Desktop could not start",
          error instanceof Error ? error.message : String(error),
        );
      }
      app.quit();
    });
}
