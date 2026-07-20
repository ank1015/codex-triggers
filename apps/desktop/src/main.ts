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

import type {
  ActiveTrigger,
  DesktopStatus,
  TriggerPageData,
} from "./shared.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const smokeTest = process.env.TRIGGER_DESKTOP_SMOKE_TEST === "1";
const execFileAsync = promisify(execFile);
const CODEX_TRIGGER_PROMPT =
  "[$manage-codex-triggers](/Users/notacoder/.codex/skills/manage-codex-triggers/SKILL.md) Create a trigger for";

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
  const config = loadConfig({
    dataDir: hasConfiguredDataDir
      ? environmentConfig.dataDir
      : join(app.getPath("userData"), "trigger"),
    ...(smokeTest ? { controlPort: 0, publicPort: 0 } : {}),
  });
  return { ...config, adminToken: null };
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

function stringProperty(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const property = value?.[key];
  return typeof property === "string" ? property : null;
}

function codexThreadId(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  return stringProperty(result as Record<string, unknown>, "threadId");
}

function getTriggerPageData(
  server: TriggerServer,
  triggerId: string,
): TriggerPageData | null {
  const details = server.system.database.getDetails(triggerId);
  if (!details) return null;

  const deliveryDetails = server.system.database.delivery
    .listDeliveries({ triggerId })
    .map(({ id }) => server.system.database.delivery.getDetails(id))
    .filter((delivery) => delivery !== null);
  const codexEntry = deliveryDetails
    .flatMap((delivery) =>
      delivery.services.map((target) => ({ delivery, target })),
    )
    .find(({ target }) => target.type === "codex-app-server");

  const notifications = server.system.database.listNotifications({
    triggerId,
    limit: 100,
  });
  const executions = server.system.database.listExecutions({
    triggerId,
    limit: 100,
  });
  const executionById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  const jobsByNotification = new Map<
    string,
    ReturnType<typeof server.system.database.delivery.listJobs>[number]
  >();
  for (const delivery of deliveryDetails) {
    for (const job of server.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
      limit: 100,
    })) {
      if (!jobsByNotification.has(job.notificationId)) {
        jobsByNotification.set(job.notificationId, job);
      }
    }
  }

  const config = codexEntry?.target.config;
  const input = codexEntry?.target.input;
  const model = stringProperty(config, "model");
  const reasoningEffort = stringProperty(config, "reasoningEffort");

  return {
    trigger: {
      id: details.trigger.id,
      name: details.trigger.name,
      kind: details.trigger.kind,
      enabled: details.trigger.enabled,
      createdAt: details.trigger.createdAt,
      updatedAt: details.trigger.updatedAt,
    },
    event: {
      code: details.revision.code,
      timeoutMs: details.revision.timeoutMs,
      schedule: details.schedule
        ? {
            kind: details.schedule.kind,
            expression: details.schedule.expression,
            timezone: details.schedule.timezone,
            nextRunAt: details.schedule.nextRunAt,
          }
        : null,
      service: details.serviceState
        ? {
            status: details.serviceState.status,
            restartCount: details.serviceState.restartCount,
            lastError: details.serviceState.lastError,
          }
        : null,
    },
    codex:
      codexEntry &&
      (model === "luna" || model === "terra" || model === "sol") &&
      (reasoningEffort === "low" ||
        reasoningEffort === "medium" ||
        reasoningEffort === "high" ||
        reasoningEffort === "xhigh")
        ? {
            deliveryId: codexEntry.delivery.delivery.id,
            targetId: codexEntry.target.id,
            enabled: codexEntry.delivery.delivery.enabled,
            prompt: stringProperty(input, "prompt") ?? "",
            projectPath: stringProperty(config, "projectPath") ?? "",
            newThread: config?.newThread === true,
            threadId: stringProperty(config, "threadId"),
            model,
            reasoningEffort,
            showInCodex: config?.threadMode === "persistent",
          }
        : null,
    recentRuns: [
      ...notifications.map((notification) => {
        const execution = executionById.get(notification.executionId);
        const job = jobsByNotification.get(notification.id);
        const persistentJob = job?.config.threadMode === "persistent";
        return {
          id: notification.id,
          status: execution?.status ?? ("succeeded" as const),
          message: notification.output.message,
          error: execution?.error ?? null,
          createdAt: notification.createdAt,
          finishedAt: job?.finishedAt ?? execution?.finishedAt ?? null,
          deliveryStatus: job?.status ?? null,
          deliveryError: job?.error ?? null,
          threadId:
            job && persistentJob
              ? codexThreadId(job.result) ??
                stringProperty(job.config, "threadId")
              : null,
        };
      }),
      ...executions
        .filter(
          (execution) =>
            !notifications.some(
              (notification) => notification.executionId === execution.id,
            ),
        )
        .map((execution) => ({
          id: execution.id,
          status: execution.status,
          message: null,
          error: execution.error,
          createdAt: execution.createdAt,
          finishedAt: execution.finishedAt,
          deliveryStatus: null,
          deliveryError: null,
          threadId: null,
        })),
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 25),
  };
}

async function setTriggerEnabled(
  server: TriggerServer,
  triggerId: string,
  enabled: boolean,
): Promise<TriggerPageData> {
  const updated = await server.system.updateTrigger(triggerId, { enabled });
  if (!updated) throw new Error("Trigger not found");
  return getTriggerPageData(server, triggerId)!;
}

function setCodexShowInCodex(
  server: TriggerServer,
  triggerId: string,
  showInCodex: boolean,
): TriggerPageData {
  const deliveries = server.system.database.delivery
    .listDeliveries({ triggerId })
    .map(({ id }) => server.system.database.delivery.getDetails(id))
    .filter((delivery) => delivery !== null);
  const entry = deliveries
    .flatMap((delivery) =>
      delivery.services.map((target) => ({ delivery, target })),
    )
    .find(({ target }) => target.type === "codex-app-server");
  if (!entry) throw new Error("Codex Delivery not found");

  const services = entry.delivery.services.map((target) => {
    if (target.id !== entry.target.id) {
      return { type: target.type, config: target.config, input: target.input };
    }
    const { threadId: _threadId, ...configWithoutThread } = target.config;
    return {
      type: target.type,
      config: showInCodex
        ? { ...target.config, threadMode: "persistent" }
        : {
            ...configWithoutThread,
            newThread: true,
            threadMode: "ephemeral",
          },
      input: target.input,
    };
  });
  server.system.delivery.update(entry.delivery.delivery.id, { services });
  return getTriggerPageData(server, triggerId)!;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (!nextEnabled) throw new Error("Simulated Tailscale stop failure");
      enabled = nextEnabled;
      return status();
    },
  };
}

async function openCodexNewChat(): Promise<void> {
  const url = `codex://threads/new?prompt=${encodeURIComponent(
    CODEX_TRIGGER_PROMPT,
  )}`;
  lastOpenedExternalUrl = url;
  if (!smokeTest) await shell.openExternal(url);
}

async function openCodexThread(threadId: string): Promise<void> {
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  lastOpenedExternalUrl = url;
  if (!smokeTest) await shell.openExternal(url);
}

async function runSmokeTest(server: TriggerServer): Promise<void> {
  const smokeTrigger = await server.system.createTrigger({
    name: "Smoke Trigger",
    kind: "webhook",
    enabled: true,
    code: `
      export default async function run(request) {
        return {
          message: "Smoke Trigger ran",
          data: {},
        }
      }
    `,
    outputSchema: { type: "object", additionalProperties: false },
    timeoutMs: 2_000,
  });
  const smokeExecution = server.system.runManually(
    smokeTrigger.details.trigger.id,
    {},
  );
  if (!smokeExecution) throw new Error("Could not create smoke execution");
  const executionDeadline = Date.now() + 4_000;
  while (
    server.system.database.getExecution(smokeExecution.id)?.status !==
      "succeeded" &&
    Date.now() < executionDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (
    server.system.database.getExecution(smokeExecution.id)?.status !==
    "succeeded"
  ) {
    throw new Error("Smoke Trigger execution did not succeed");
  }
  server.system.database.addNotification({
    id: "smoke-second-notification",
    triggerId: smokeTrigger.details.trigger.id,
    executionId: smokeExecution.id,
    output: {
      message: "Second Smoke Trigger notification",
      data: {},
    },
    status: "recorded",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });
  server.system.delivery.create({
    name: "Smoke Codex Delivery",
    triggerId: smokeTrigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "codex-app-server",
        config: {
          projectPath: "/tmp/smoke-project",
          newThread: false,
          threadId: "smoke-thread",
          model: "luna",
          reasoningEffort: "medium",
          threadMode: "persistent",
        },
        input: { prompt: "Handle this Trigger: {{message}}" },
      },
    ],
  });
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
    `(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        logo: document.querySelector(".app-logo")?.getAttribute("src"),
        settingsLabel: document.querySelector(".settings-button")?.getAttribute("aria-label"),
        sectionTitle: document.querySelector(".active-triggers-title")?.textContent,
        triggerName: document.querySelector(".trigger-card h2")?.textContent,
        triggerLabel: document.querySelector(".trigger-card")?.getAttribute("aria-label"),
        addLabel: document.querySelector(".add-trigger-card")?.getAttribute("aria-label"),
      };
    })()`,
  )) as {
    logo?: string;
    settingsLabel?: string;
    sectionTitle?: string;
    triggerName?: string;
    triggerLabel?: string;
    addLabel?: string;
  };
  if (
    renderedHeader.logo !== "./logo.jpg" ||
    renderedHeader.settingsLabel !== "Settings" ||
    renderedHeader.sectionTitle !== "Active Triggers" ||
    renderedHeader.triggerName !== "Smoke Trigger" ||
    renderedHeader.triggerLabel !== "Open Smoke Trigger" ||
    renderedHeader.addLabel !== "Create a Trigger"
  ) {
    throw new Error(
      `Desktop UI rendered an unexpected header: ${JSON.stringify(renderedHeader)}`,
    );
  }

  await server.system.createTrigger({
    name: "Refreshed Trigger",
    kind: "webhook",
    enabled: true,
    code: `
      export default async function run(request) {
        return {
          message: "Refreshed Trigger ran",
          data: {},
        }
      }
    `,
    outputSchema: { type: "object", additionalProperties: false },
    timeoutMs: 2_000,
  });
  const refreshedTriggerNames = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const names = Array.from(document.querySelectorAll(".trigger-card h2"))
          .map(element => element.textContent);
        if (names.includes("Refreshed Trigger")) return names;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return Array.from(document.querySelectorAll(".trigger-card h2"))
        .map(element => element.textContent);
    })()`,
  )) as Array<string | null>;
  if (!refreshedTriggerNames.includes("Refreshed Trigger")) {
    throw new Error(
      `Desktop UI did not refresh its Trigger query: ${JSON.stringify(refreshedTriggerNames)}`,
    );
  }

  const triggerPage = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector('[aria-label="Open Smoke Trigger"]')?.click();
      const deadline = Date.now() + 2_000;
      while (!document.querySelector(".trigger-detail-heading h1") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const page = document.querySelector(".trigger-detail-content");
      return {
        triggerId: page?.getAttribute("data-trigger-id"),
        backLabel: document.querySelector(".header-icon-button")?.getAttribute("aria-label"),
        title: document.querySelector(".trigger-detail-heading h1")?.textContent,
        enabled: document.querySelector('[aria-label="Trigger enabled"]')?.getAttribute("aria-checked"),
        eventType: document.querySelector(".trigger-type-badge")?.textContent?.trim(),
        code: document.querySelector(".code-block code")?.textContent,
        prompt: document.querySelector(".codex-prompt code")?.textContent,
        model: document.querySelector(".codex-options-grid dd")?.textContent,
        showInCodex: document.querySelector('[aria-label="Show in Codex"]')?.getAttribute("aria-checked"),
        recentMessage: document.querySelector(".recent-run-copy p")?.textContent,
        recentCount: document.querySelectorAll(".recent-runs-list li").length,
      };
    })()`,
  )) as {
    triggerId?: string;
    backLabel?: string;
    title?: string;
    enabled?: string;
    eventType?: string;
    code?: string;
    prompt?: string;
    model?: string;
    showInCodex?: string;
    recentMessage?: string;
    recentCount?: number;
  };
  if (
    triggerPage.triggerId !== smokeTrigger.details.trigger.id ||
    triggerPage.backLabel !== "Go back" ||
    triggerPage.title !== "Smoke Trigger" ||
    triggerPage.enabled !== "true" ||
    triggerPage.eventType !== "Webhook Trigger" ||
    !triggerPage.code?.includes("Smoke Trigger ran") ||
    triggerPage.prompt !== "Handle this Trigger: {{message}}" ||
    triggerPage.model !== "luna" ||
    triggerPage.showInCodex !== "true" ||
    triggerPage.recentMessage !== "Second Smoke Trigger notification" ||
    triggerPage.recentCount !== 2
  ) {
    throw new Error(
      `Desktop UI rendered an unexpected Trigger page: ${JSON.stringify(triggerPage)}`,
    );
  }

  const toggles = (await window.webContents.executeJavaScript(
    `(async () => {
      const waitChecked = async (element, expected) => {
        const deadline = Date.now() + 2_000;
        while (element?.getAttribute("aria-checked") !== expected && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return element?.getAttribute("aria-checked");
      };
      const triggerToggle = document.querySelector('[aria-label="Trigger enabled"]');
      triggerToggle?.click();
      const disabled = await waitChecked(triggerToggle, "false");
      triggerToggle?.click();
      const reenabled = await waitChecked(triggerToggle, "true");

      const codexToggle = document.querySelector('[aria-label="Show in Codex"]');
      codexToggle?.click();
      const hidden = await waitChecked(codexToggle, "false");
      codexToggle?.click();
      const reshown = await waitChecked(codexToggle, "true");
      return {
        disabled,
        reenabled,
        hidden,
        reshown,
      };
    })()`,
  )) as Record<string, string | undefined>;
  if (
    toggles.disabled !== "false" ||
    toggles.reenabled !== "true" ||
    toggles.hidden !== "false" ||
    toggles.reshown !== "true"
  ) {
    throw new Error(
      `Desktop UI Trigger toggles failed: ${JSON.stringify(toggles)}`,
    );
  }

  await window.webContents.executeJavaScript(
    `window.desktop.openCodexThread("smoke-thread")`,
  );
  if (lastOpenedExternalUrl !== "codex://threads/smoke-thread") {
    throw new Error(
      `Open in Codex used an unexpected URL: ${lastOpenedExternalUrl}`,
    );
  }

  const triggerPageReturnedTitle = await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".header-icon-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return document.querySelector(".active-triggers-title")?.textContent;
    })()`,
  );
  if (triggerPageReturnedTitle !== "Active Triggers") {
    throw new Error(
      `Desktop UI Trigger back navigation failed: ${triggerPageReturnedTitle}`,
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
  if (
    lastOpenedExternalUrl !==
    `codex://threads/new?prompt=${encodeURIComponent(CODEX_TRIGGER_PROMPT)}`
  ) {
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

  const failedStop = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".toggle-switch")?.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        enabled: document.querySelector(".toggle-switch")?.getAttribute("aria-checked"),
        error: document.querySelector(".setting-error")?.textContent,
      };
    })()`,
  )) as { enabled?: string; error?: string };
  if (
    failedStop.enabled !== "true" ||
    failedStop.error !==
      "Tailscale could not update the webhook tunnel: Simulated Tailscale stop failure"
  ) {
    throw new Error(
      `Desktop UI did not contain a Tailscale stop failure: ${JSON.stringify(failedStop)}`,
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
  ipcMain.handle("desktop:get-trigger-page", (_event, triggerId: unknown) => {
    if (typeof triggerId !== "string" || triggerId.trim() === "") return null;
    return getTriggerPageData(triggerServer!, triggerId);
  });
  ipcMain.handle(
    "desktop:set-trigger-enabled",
    (_event, triggerId: unknown, enabled: unknown) => {
      if (typeof triggerId !== "string" || typeof enabled !== "boolean") {
        throw new Error("Invalid Trigger update");
      }
      return setTriggerEnabled(triggerServer!, triggerId, enabled);
    },
  );
  ipcMain.handle(
    "desktop:set-codex-show-in-codex",
    (_event, triggerId: unknown, showInCodex: unknown) => {
      if (
        typeof triggerId !== "string" ||
        typeof showInCodex !== "boolean"
      ) {
        throw new Error("Invalid Codex Delivery update");
      }
      return setCodexShowInCodex(
        triggerServer!,
        triggerId,
        showInCodex,
      );
    },
  );
  ipcMain.handle("desktop:open-codex-new-chat", openCodexNewChat);
  ipcMain.handle("desktop:open-codex-thread", (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim() === "") {
      throw new Error("Invalid Codex thread ID");
    }
    return openCodexThread(threadId);
  });
  ipcMain.handle("desktop:get-webhook-tunnel-settings", () =>
    triggerServer!.system.getWebhookTunnelStatus(),
  );
  ipcMain.handle(
    "desktop:set-webhook-tunnel-enabled",
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return {
          enabled: false,
          publicWebhookUrl: null,
          error: "The Tailscale tunnel setting was invalid.",
        };
      }
      try {
        return await triggerServer!.system.setWebhookTunnelEnabled(enabled);
      } catch (error) {
        const status = await triggerServer!.system.getWebhookTunnelStatus();
        return {
          ...status,
          error: `Tailscale could not update the webhook tunnel: ${errorMessage(error)}`,
        };
      }
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
        app.exit(exitCode);
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
