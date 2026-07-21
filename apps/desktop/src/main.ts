import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  findCodexAppServerExecutable,
  loadConfig,
  TriggerServer,
  type WebhookTunnel,
  type WebhookTunnelStatus,
} from "@codexmaxxing/trigger";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification as ElectronNotification,
  shell,
} from "electron";

import { IDEA_TOPICS, IDEAS } from "./ideas.js";
import type {
  CodexModel,
  CodexReasoningEffort,
  DesktopStatus,
  MacosNotificationPermission,
  TriggerSummary,
  TriggerPageData,
} from "./shared.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const smokeTest = process.env.TRIGGER_DESKTOP_SMOKE_TEST === "1";
const execFileAsync = promisify(execFile);
const SKILL_NAME = "manage-codex-triggers";
const ONBOARDING_VERSION = 1;

const macPermissions =
  process.platform === "darwin"
    ? (require("node-mac-permissions") as typeof import("node-mac-permissions"))
    : null;

if (smokeTest) {
  app.setPath("userData", join(tmpdir(), `codex-triggers-smoke-${process.pid}`));
}

let window: BrowserWindow | null = null;
let triggerServer: TriggerServer | null = null;
let shutdownComplete = false;
let exitCode = 0;
let lastOpenedExternalUrl: string | null = null;
let smokeCodexAvailable = false;
let unsubscribeTriggerNotifications: (() => void) | null = null;
let unsubscribeDeliveryNotifications: (() => void) | null = null;
let lastDesktopNotification:
  | { triggerId: string; title: string; body: string }
  | null = null;
let pendingTriggerNavigation: TriggerSummary | null = null;
const windowLoads = new WeakMap<BrowserWindow, Promise<void>>();

function currentDesktopNotification() {
  return lastDesktopNotification;
}

function onboardingMarkerPath(): string {
  return join(app.getPath("userData"), "onboarding.json");
}

function bundledSkillPath(): string {
  return join(directory, "skills", SKILL_NAME);
}

function installedSkillPath(): string {
  return smokeTest
    ? join(app.getPath("userData"), ".codex", "skills", SKILL_NAME)
    : join(
        process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
        "skills",
        SKILL_NAME,
      );
}

function codexTriggerPrompt(instruction = "Create a trigger for"): string {
  return `[$${SKILL_NAME}](${join(installedSkillPath(), "SKILL.md")}) ${instruction}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directoryPath: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directoryPath, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`directory:${name}\0`);
        await visit(path);
      } else if (entry.isFile()) {
        hash.update(`file:${name}\0`);
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function installBundledSkill(): Promise<{
  skill: "installed" | "updated" | "current";
  hash: string;
}> {
  const source = bundledSkillPath();
  const destination = installedSkillPath();
  if (!(await pathExists(join(source, "SKILL.md")))) {
    throw new Error("The bundled Codex Triggers skill could not be found.");
  }
  const sourceHash = await hashDirectory(source);
  const destinationExists = await pathExists(destination);
  if (
    destinationExists &&
    (await hashDirectory(destination).catch(() => null)) === sourceHash
  ) {
    return { skill: "current", hash: sourceHash };
  }

  const parent = dirname(destination);
  const temporary = join(parent, `.${SKILL_NAME}-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  try {
    await cp(source, temporary, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    skill: destinationExists ? "updated" : "installed",
    hash: sourceHash,
  };
}

async function getOnboardingStatus(): Promise<{ completed: boolean }> {
  try {
    const marker = JSON.parse(
      await readFile(onboardingMarkerPath(), "utf8"),
    ) as { version?: unknown; completed?: unknown };
    return {
      completed:
        marker.version === ONBOARDING_VERSION && marker.completed === true,
    };
  } catch {
    return { completed: false };
  }
}

async function syncBundledSkillAfterUpdate(): Promise<void> {
  if (!(await getOnboardingStatus()).completed) return;
  const installed = await installBundledSkill();
  if (installed.skill === "current") return;

  const markerPath = onboardingMarkerPath();
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
    string,
    unknown
  >;
  const temporary = `${markerPath}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      ...marker,
      skillHash: installed.hash,
      skillUpdatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, markerPath);
}

async function completeOnboarding(): Promise<{
  completed: true;
  skill: "installed" | "updated" | "current";
}> {
  const codexExecutable = smokeTest
    ? smokeCodexAvailable
      ? process.execPath
      : null
    : await findCodexAppServerExecutable();
  if (!codexExecutable) {
    throw new Error(
      "Codex app-server is not available. Install or update the Codex app, then try again.",
    );
  }

  const installed = await installBundledSkill();
  const marker = onboardingMarkerPath();
  const temporary = `${marker}.tmp-${process.pid}`;
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(
    temporary,
    `${JSON.stringify({
      version: ONBOARDING_VERSION,
      completed: true,
      completedAt: new Date().toISOString(),
      skillHash: installed.hash,
      codexExecutable,
    }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, marker);
  return { completed: true, skill: installed.skill };
}

function createWindow(show = true): BrowserWindow {
  const created = new BrowserWindow({
    show,
    width: 780,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: "Codex Triggers",
    backgroundColor: "#0f0f11",
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

function listTriggers(server: TriggerServer): TriggerSummary[] {
  return server.system.database
    .listTriggers()
    .map(({ id, name, kind, enabled, macosNotificationsEnabled }) => ({
      id,
      name,
      kind,
      enabled,
      macosNotificationsEnabled,
    }));
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
      macosNotificationsEnabled:
        details.trigger.macosNotificationsEnabled,
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
        const isServiceNotification = execution?.kind === "service";
        return {
          id: notification.id,
          status: isServiceNotification
            ? ("succeeded" as const)
            : execution?.status ?? ("succeeded" as const),
          message: notification.output.message,
          error: isServiceNotification ? null : execution?.error ?? null,
          createdAt: notification.createdAt,
          finishedAt: job?.finishedAt ?? execution?.finishedAt ?? null,
          deliveryStatus: job?.status ?? null,
          deliveryError: job?.error ?? null,
          threadId:
            job?.status === "succeeded" && persistentJob
              ? codexThreadId(job.result) ??
                stringProperty(job.config, "threadId")
              : null,
        };
      }),
      ...executions
        .filter(
          (execution) =>
            execution.kind !== "service" &&
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

async function setMacosNotificationsEnabled(
  server: TriggerServer,
  triggerId: string,
  enabled: boolean,
): Promise<TriggerPageData> {
  const updated = await server.system.updateTrigger(triggerId, {
    macosNotificationsEnabled: enabled,
  });
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

function setCodexOptions(
  server: TriggerServer,
  triggerId: string,
  options: {
    model?: CodexModel;
    reasoningEffort?: CodexReasoningEffort;
  },
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

  const services = entry.delivery.services.map((target) => ({
    type: target.type,
    config:
      target.id === entry.target.id
        ? { ...target.config, ...options }
        : target.config,
    input: target.input,
  }));
  server.system.delivery.update(entry.delivery.delivery.id, { services });
  return getTriggerPageData(server, triggerId)!;
}

function isCodexModel(value: unknown): value is CodexModel {
  return value === "luna" || value === "terra" || value === "sol";
}

function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
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

async function openCodexNewChat(prompt?: string): Promise<void> {
  const url = `codex://threads/new?prompt=${encodeURIComponent(
    codexTriggerPrompt(prompt),
  )}`;
  lastOpenedExternalUrl = url;
  if (!smokeTest) await shell.openExternal(url);
}

async function openCodexThread(threadId: string): Promise<void> {
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  lastOpenedExternalUrl = url;
  if (!smokeTest) await shell.openExternal(url);
}

async function openTriggerFromNotification(triggerId: string): Promise<void> {
  const trigger = triggerServer?.system.database.getTrigger(triggerId);
  if (!trigger) return;
  const summary = {
    id: trigger.id,
    name: trigger.name,
    kind: trigger.kind,
    enabled: trigger.enabled,
    macosNotificationsEnabled: trigger.macosNotificationsEnabled,
  } satisfies TriggerSummary;
  pendingTriggerNavigation = summary;
  if (!window) window = createWindow();
  await windowLoads.get(window);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("desktop:open-trigger", summary);
}

async function openMacosNotificationSettings(): Promise<void> {
  if (smokeTest) return;
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  );
}

function getMacosNotificationPermission(): MacosNotificationPermission {
  if (smokeTest) return "authorized";
  if (!macPermissions || !ElectronNotification.isSupported()) {
    return "unavailable";
  }
  const status = macPermissions.getAuthStatus("notifications");
  switch (status) {
    case "authorized":
    case "provisional":
    case "denied":
    case "restricted":
      return status;
    case "not determined":
      return "not-determined";
    default:
      return "unavailable";
  }
}

async function requestMacosNotificationPermission(): Promise<MacosNotificationPermission> {
  let status = getMacosNotificationPermission();
  if (status !== "not-determined") return status;

  const notification = new ElectronNotification({
    title: "Codex Triggers",
    body: "Notifications are ready.",
  });
  notification.show();

  const deadline = Date.now() + 60_000;
  while (status === "not-determined" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = getMacosNotificationPermission();
  }
  return status;
}

function startDesktopNotifications(server: TriggerServer): void {
  unsubscribeTriggerNotifications?.();
  unsubscribeDeliveryNotifications?.();
  unsubscribeTriggerNotifications = server.system.notifications.subscribe(
    (recorded) => {
      const trigger = server.system.database.getTrigger(recorded.triggerId);
      if (!trigger?.macosNotificationsEnabled) return;
      lastDesktopNotification = {
        triggerId: trigger.id,
        title: trigger.name,
        body: recorded.output.message,
      };
      if (smokeTest || !ElectronNotification.isSupported()) return;
      const notification = new ElectronNotification({
        title: trigger.name,
        body: recorded.output.message,
      });
      notification.on("click", () => {
        void openTriggerFromNotification(trigger.id);
      });
      notification.on("show", () => {
        console.log(`macOS notification shown for Trigger ${trigger.id}`);
      });
      notification.on("failed", (_event, error) => {
        console.error(
          `macOS notification failed for Trigger ${trigger.id}: ${error}`,
        );
      });
      notification.show();
    },
  );
  unsubscribeDeliveryNotifications = server.system.delivery.subscribe((job) => {
    if (
      job.status !== "succeeded" ||
      job.serviceType !== "codex-app-server" ||
      job.config.threadMode !== "persistent"
    ) {
      return;
    }
    const recorded = server.system.database.getNotification(job.notificationId);
    if (!recorded) return;
    const trigger = server.system.database.getTrigger(recorded.triggerId);
    if (!trigger?.macosNotificationsEnabled) return;
    const threadId =
      codexThreadId(job.result) ?? stringProperty(job.config, "threadId");
    if (!threadId || smokeTest || !ElectronNotification.isSupported()) return;

    const notification = new ElectronNotification({
      title: `${trigger.name} completed`,
      body: "Codex finished running. Click to open the task.",
    });
    notification.on("click", () => {
      void openCodexThread(threadId);
    });
    notification.on("show", () => {
      console.log(`Codex completion notification shown for task ${threadId}`);
    });
    notification.on("failed", (_event, error) => {
      console.error(
        `Codex completion notification failed for task ${threadId}: ${error}`,
      );
    });
    notification.show();
  });
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
  if (
    lastDesktopNotification?.triggerId !== smokeTrigger.details.trigger.id ||
    lastDesktopNotification.title !== "Smoke Trigger" ||
    lastDesktopNotification.body !== "Smoke Trigger ran"
  ) {
    throw new Error(
      `Desktop notification was not emitted: ${JSON.stringify(lastDesktopNotification)}`,
    );
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
  const onboardingFailure = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 2_000;
      while (!document.querySelector(".onboarding-start-button") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const initial = {
        title: document.querySelector(".onboarding-content h1")?.textContent,
        action: document.querySelector(".onboarding-start-button")?.textContent,
        headerVisible: Boolean(document.querySelector(".app-header")),
      };
      document.querySelector(".onboarding-start-button")?.click();
      while (!document.querySelector(".onboarding-error-toast") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        ...initial,
        error: document.querySelector(".onboarding-error-toast p")?.textContent,
      };
    })()`,
  )) as {
    title?: string;
    action?: string;
    headerVisible?: boolean;
    error?: string;
  };
  if (
    onboardingFailure.title !== "Codex Triggers" ||
    onboardingFailure.action !== "Let's Start" ||
    onboardingFailure.headerVisible !== false ||
    onboardingFailure.error !==
      "Codex app-server is not available. Install or update the Codex app, then try again."
  ) {
    throw new Error(
      `Desktop UI onboarding failure state was unexpected: ${JSON.stringify(onboardingFailure)}`,
    );
  }

  smokeCodexAvailable = true;
  const onboardingSuccess = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".onboarding-start-button")?.click();
      const deadline = Date.now() + 4_000;
      while (!document.querySelector(".triggers-title") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        title: document.querySelector(".triggers-title")?.textContent,
        onboardingVisible: Boolean(document.querySelector(".onboarding-page")),
      };
    })()`,
  )) as { title?: string; onboardingVisible?: boolean };
  if (
    onboardingSuccess.title !== "Triggers" ||
    onboardingSuccess.onboardingVisible !== false ||
    !(await getOnboardingStatus()).completed ||
    !(await pathExists(join(installedSkillPath(), "SKILL.md")))
  ) {
    throw new Error(
      `Desktop UI onboarding did not complete: ${JSON.stringify(onboardingSuccess)}`,
    );
  }

  const reloaded = new Promise<void>((resolvePromise) => {
    window!.webContents.once("did-finish-load", () => resolvePromise());
  });
  window.webContents.reload();
  await reloaded;
  const persistedOnboarding = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 2_000;
      while (!document.querySelector(".triggers-title") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        title: document.querySelector(".triggers-title")?.textContent,
        onboardingVisible: Boolean(document.querySelector(".onboarding-page")),
      };
    })()`,
  )) as { title?: string; onboardingVisible?: boolean };
  if (
    persistedOnboarding.title !== "Triggers" ||
    persistedOnboarding.onboardingVisible !== false
  ) {
    throw new Error(
      `Desktop UI onboarding was not persisted: ${JSON.stringify(persistedOnboarding)}`,
    );
  }

  const renderedHeader = (await window.webContents.executeJavaScript(
    `(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        logo: document.querySelector(".app-logo")?.getAttribute("src"),
        settingsLabel: document.querySelector(".settings-button")?.getAttribute("aria-label"),
        sectionTitle: document.querySelector(".triggers-title")?.textContent,
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
    renderedHeader.logo !== "./logo-2.png" ||
    renderedHeader.settingsLabel !== "Settings" ||
    renderedHeader.sectionTitle !== "Triggers" ||
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
        codeInitiallyOpen: document.querySelector(".code-disclosure")?.hasAttribute("open"),
        code: document.querySelector(".code-block code")?.textContent,
        prompt: document.querySelector(".codex-prompt code")?.textContent,
        model: document.querySelector('[aria-label="Codex model"]')?.value,
        macosNotification: document.querySelector('[aria-label="macOS Notification"]')?.getAttribute("aria-checked"),
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
    codeInitiallyOpen?: boolean;
    code?: string;
    prompt?: string;
    model?: string;
    macosNotification?: string;
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
    triggerPage.codeInitiallyOpen !== false ||
    !triggerPage.code?.includes("Smoke Trigger ran") ||
    triggerPage.prompt !== "Handle this Trigger: {{message}}" ||
    triggerPage.model !== "luna" ||
    triggerPage.macosNotification !== "true" ||
    triggerPage.showInCodex !== "true" ||
    triggerPage.recentMessage !== "Second Smoke Trigger notification" ||
    triggerPage.recentCount !== 2
  ) {
    throw new Error(
      `Desktop UI rendered an unexpected Trigger page: ${JSON.stringify(triggerPage)}`,
    );
  }

  const codexOptionChanges = (await window.webContents.executeJavaScript(
    `(async () => {
      const waitValue = async (element, expected) => {
        const deadline = Date.now() + 2_000;
        while (element?.value !== expected && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return element?.value;
      };
      const disclosure = document.querySelector(".code-disclosure");
      document.querySelector(".code-disclosure summary")?.click();

      const model = document.querySelector('[aria-label="Codex model"]');
      model.value = "terra";
      model.dispatchEvent(new Event("change", { bubbles: true }));
      const updatedModel = await waitValue(model, "terra");

      const reasoning = document.querySelector('[aria-label="Codex reasoning"]');
      reasoning.value = "high";
      reasoning.dispatchEvent(new Event("change", { bubbles: true }));
      const updatedReasoning = await waitValue(reasoning, "high");
      return {
        codeOpened: disclosure?.hasAttribute("open"),
        updatedModel,
        updatedReasoning,
      };
    })()`,
  )) as {
    codeOpened?: boolean;
    updatedModel?: string;
    updatedReasoning?: string;
  };
  const updatedCodexTarget = server.system.database.delivery
    .listDeliveries({ triggerId: smokeTrigger.details.trigger.id })
    .flatMap(({ id }) =>
      server.system.database.delivery.getDetails(id)?.services ?? [],
    )
    .find(({ type }) => type === "codex-app-server");
  if (
    codexOptionChanges.codeOpened !== true ||
    codexOptionChanges.updatedModel !== "terra" ||
    codexOptionChanges.updatedReasoning !== "high" ||
    updatedCodexTarget?.config.model !== "terra" ||
    updatedCodexTarget.config.reasoningEffort !== "high"
  ) {
    throw new Error(
      `Desktop UI Codex options failed: ${JSON.stringify({ codexOptionChanges, config: updatedCodexTarget?.config })}`,
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

      const macosToggle = document.querySelector('[aria-label="macOS Notification"]');
      macosToggle?.click();
      const macosDisabled = await waitChecked(macosToggle, "false");
      macosToggle?.click();
      const macosReenabled = await waitChecked(macosToggle, "true");

      const codexToggle = document.querySelector('[aria-label="Show in Codex"]');
      codexToggle?.click();
      const hidden = await waitChecked(codexToggle, "false");
      codexToggle?.click();
      const reshown = await waitChecked(codexToggle, "true");
      return {
        disabled,
        macosDisabled,
        macosReenabled,
        hidden,
        reshown,
      };
    })()`,
  )) as Record<string, string | undefined>;
  if (
    toggles.disabled !== "false" ||
    toggles.macosDisabled !== "false" ||
    toggles.macosReenabled !== "true" ||
    toggles.hidden !== "false" ||
    toggles.reshown !== "true"
  ) {
    throw new Error(
      `Desktop UI Trigger toggles failed: ${JSON.stringify(toggles)}`,
    );
  }

  await server.system.updateTrigger(smokeTrigger.details.trigger.id, {
    macosNotificationsEnabled: false,
  });
  lastDesktopNotification = null;
  const mutedExecution = server.system.runManually(
    smokeTrigger.details.trigger.id,
    {},
  )!;
  const mutedDeadline = Date.now() + 4_000;
  while (
    server.system.database.getExecution(mutedExecution.id)?.status !==
      "succeeded" &&
    Date.now() < mutedDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (lastDesktopNotification !== null) {
    throw new Error("Disabled macOS notifications still emitted an alert");
  }

  await server.system.updateTrigger(smokeTrigger.details.trigger.id, {
    macosNotificationsEnabled: true,
  });
  const notifiedExecution = server.system.runManually(
    smokeTrigger.details.trigger.id,
    {},
  )!;
  const notifiedDeadline = Date.now() + 4_000;
  while (
    server.system.database.getExecution(notifiedExecution.id)?.status !==
      "succeeded" &&
    Date.now() < notifiedDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (
    currentDesktopNotification()?.triggerId !==
    smokeTrigger.details.trigger.id
  ) {
    throw new Error("Re-enabled macOS notifications did not emit an alert");
  }

  await window.webContents.executeJavaScript(
    `window.desktop.openCodexThread("smoke-thread")`,
  );
  if (lastOpenedExternalUrl !== "codex://threads/smoke-thread") {
    throw new Error(
      `Open in Codex used an unexpected URL: ${lastOpenedExternalUrl}`,
    );
  }

  const inactiveTriggerOnHome = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".header-icon-button")?.click();
      const deadline = Date.now() + 2_000;
      let card;
      while (!card && Date.now() < deadline) {
        card = document.querySelector('[aria-label="Open Smoke Trigger"]');
        if (!card) await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        title: document.querySelector(".triggers-title")?.textContent,
        cardPresent: Boolean(card),
        status: card?.querySelector(".trigger-card-meta span:last-child")?.textContent,
        inactiveClass: card?.classList.contains("trigger-card-inactive"),
      };
    })()`,
  )) as {
    title?: string;
    cardPresent?: boolean;
    status?: string;
    inactiveClass?: boolean;
  };
  if (
    inactiveTriggerOnHome.title !== "Triggers" ||
    inactiveTriggerOnHome.cardPresent !== true ||
    inactiveTriggerOnHome.status !== "Inactive" ||
    inactiveTriggerOnHome.inactiveClass !== true
  ) {
    throw new Error(
      `Desktop UI hid or misrepresented an inactive Trigger: ${JSON.stringify(inactiveTriggerOnHome)}`,
    );
  }

  await openTriggerFromNotification(smokeTrigger.details.trigger.id);
  const notificationNavigation = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 2_000;
      while (!document.querySelector(".trigger-detail-heading h1") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return document.querySelector(".trigger-detail-heading h1")?.textContent;
    })()`,
  )) as string | undefined;
  if (notificationNavigation !== "Smoke Trigger") {
    throw new Error(
      `Desktop notification did not open its Trigger: ${notificationNavigation}`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector(".header-icon-button")?.click()`,
  );

  const reenabledTrigger = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector('[aria-label="Open Smoke Trigger"]')?.click();
      const deadline = Date.now() + 2_000;
      while (!document.querySelector('[aria-label="Trigger enabled"]') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const toggle = document.querySelector('[aria-label="Trigger enabled"]');
      toggle?.click();
      while (toggle?.getAttribute("aria-checked") !== "true" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const enabled = toggle?.getAttribute("aria-checked");
      document.querySelector(".header-icon-button")?.click();
      while (!document.querySelector(".triggers-title") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      let status;
      while (Date.now() < deadline) {
        status = document.querySelector('[aria-label="Open Smoke Trigger"] .trigger-card-meta span:last-child')?.textContent;
        if (status === "Active") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        enabled,
        status,
      };
    })()`,
  )) as { enabled?: string; status?: string };
  if (
    reenabledTrigger.enabled !== "true" ||
    reenabledTrigger.status !== "Active"
  ) {
    throw new Error(
      `Desktop UI could not restore an inactive Trigger: ${JSON.stringify(reenabledTrigger)}`,
    );
  }

  const listenerTrigger = await server.system.createTrigger({
    name: "Silent Listener",
    kind: "service",
    enabled: true,
    code: `
      export default {
        async start(ctx) {
          await ctx.untilStopped()
        }
      }
    `,
    outputSchema: true,
    timeoutMs: 0,
  });
  const listenerDeadline = Date.now() + 4_000;
  while (
    server.system.database.getServiceState(
      listenerTrigger.details.trigger.id,
    )?.status !== "running" &&
    Date.now() < listenerDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listenerPage = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 4_000;
      let card;
      while (!card && Date.now() < deadline) {
        card = document.querySelector('[aria-label="Open Silent Listener"]');
        if (!card) await new Promise(resolve => setTimeout(resolve, 50));
      }
      card?.click();
      while (!document.querySelector(".trigger-detail-heading h1") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        title: document.querySelector(".trigger-detail-heading h1")?.textContent,
        status: document.querySelector(".run-status")?.textContent?.trim(),
        empty: document.querySelector(".empty-recent-runs")?.textContent,
        count: document.querySelectorAll(".recent-runs-list li").length,
      };
    })()`,
  )) as {
    title?: string;
    status?: string;
    empty?: string;
    count?: number;
  };
  if (
    listenerPage.title !== "Silent Listener" ||
    listenerPage.status !== undefined ||
    listenerPage.empty !== "This Trigger has not run yet." ||
    listenerPage.count !== 0
  ) {
    throw new Error(
      `Desktop UI exposed a Service lifecycle execution: ${JSON.stringify(listenerPage)}`,
    );
  }
  const interruptedServiceExecution =
    server.system.database.createExecution({
      id: "smoke-interrupted-service-execution",
      triggerId: listenerTrigger.details.trigger.id,
      revisionId: listenerTrigger.details.revision.id,
      kind: "service",
      status: "running",
      event: { type: "service", startedAt: new Date().toISOString() },
    });
  server.system.database.addNotification({
    id: "smoke-service-notification",
    triggerId: listenerTrigger.details.trigger.id,
    executionId: interruptedServiceExecution.id,
    output: {
      message: "Historical service notification",
      data: {},
    },
    status: "recorded",
    createdAt: new Date().toISOString(),
  });
  server.system.database.finishExecution(
    interruptedServiceExecution.id,
    "interrupted",
    "Trigger host restarted during execution",
  );
  const historicalServiceNotification =
    (await window.webContents.executeJavaScript(
      `(async () => {
        const deadline = Date.now() + 4_000;
        while (
          document.querySelector(".recent-run-copy p")?.textContent !==
            "Historical service notification" &&
          Date.now() < deadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return {
          message: document.querySelector(".recent-run-copy p")?.textContent,
          status: document.querySelector(".run-status")?.textContent?.trim(),
          error: document.querySelector(".recent-run-copy small")?.textContent,
          count: document.querySelectorAll(".recent-runs-list li").length,
        };
      })()`,
    )) as {
      message?: string;
      status?: string;
      error?: string;
      count?: number;
    };
  if (
    historicalServiceNotification.message !==
      "Historical service notification" ||
    historicalServiceNotification.status !== "Succeeded" ||
    historicalServiceNotification.error !== undefined ||
    historicalServiceNotification.count !== 1
  ) {
    throw new Error(
      `Desktop UI inherited a Service lifecycle error: ${JSON.stringify(historicalServiceNotification)}`,
    );
  }
  const deletion = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".delete-trigger-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const dialogTitle = document.querySelector("#delete-dialog-title")?.textContent;
      document.querySelector(".dialog-cancel-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const cancelled = !document.querySelector(".confirmation-dialog");

      document.querySelector(".delete-trigger-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector(".dialog-delete-button")?.click();
      const deadline = Date.now() + 4_000;
      while (!document.querySelector(".triggers-title") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        dialogTitle,
        cancelled,
        returnedTitle: document.querySelector(".triggers-title")?.textContent,
        deletedCard: Boolean(document.querySelector('[aria-label="Open Silent Listener"]')),
      };
    })()`,
  )) as {
    dialogTitle?: string;
    cancelled?: boolean;
    returnedTitle?: string;
    deletedCard?: boolean;
  };
  if (
    deletion.dialogTitle !== "Delete this Trigger?" ||
    deletion.cancelled !== true ||
    deletion.returnedTitle !== "Triggers" ||
    deletion.deletedCard !== false ||
    server.system.database.getTrigger(listenerTrigger.details.trigger.id) !== null
  ) {
    throw new Error(
      `Desktop UI Trigger deletion failed: ${JSON.stringify(deletion)}`,
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
    createPage.section !== "Ideas"
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
    `codex://threads/new?prompt=${encodeURIComponent(codexTriggerPrompt())}`
  ) {
    throw new Error(
      `Ask Codex opened an unexpected URL: ${lastOpenedExternalUrl}`,
    );
  }

  const emptyTopicLabel =
    IDEA_TOPICS.find(
      ({ id }) => !IDEAS.some(({ tags }) => tags.includes(id)),
    )?.label ?? null;
  const ideasPage = (await window.webContents.executeJavaScript(
    `(async () => {
      const chipByLabel = (label) =>
        Array.from(document.querySelectorAll(".topic-chip"))
          .find((chip) => chip.textContent === label);
      const cardTitles = () =>
        Array.from(document.querySelectorAll(".idea-card h3"))
          .map((element) => element.textContent);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

      const chips = Array.from(document.querySelectorAll(".topic-chip"))
        .map((chip) => chip.textContent);
      const allTitles = cardTitles();

      chipByLabel("Developer")?.click();
      await settle();
      const developerTitles = cardTitles();
      const developerPressed =
        chipByLabel("Developer")?.getAttribute("aria-pressed");

      chipByLabel("Productivity")?.click();
      await settle();
      const unionTitles = cardTitles();

      chipByLabel("Developer")?.click();
      chipByLabel("Productivity")?.click();
      const emptyTopicLabel = ${JSON.stringify(emptyTopicLabel)};
      let emptyTopicMessage = null;
      if (emptyTopicLabel) {
        chipByLabel(emptyTopicLabel)?.click();
        await settle();
        emptyTopicMessage =
          document.querySelector(".empty-ideas")?.textContent ?? null;
        chipByLabel(emptyTopicLabel)?.click();
      }
      await settle();
      const restoredCount = document.querySelectorAll(".idea-card").length;
      document.querySelector(".idea-card")?.click();
      await settle();
      return {
        chips,
        allTitles,
        developerTitles,
        developerPressed,
        unionTitles,
        emptyTopicMessage,
        restoredCount,
      };
    })()`,
  )) as {
    chips?: Array<string | null>;
    allTitles?: Array<string | null>;
    developerTitles?: Array<string | null>;
    developerPressed?: string;
    unionTitles?: Array<string | null>;
    emptyTopicMessage?: string | null;
    restoredCount?: number;
  };
  const matchesTitles = (
    actual: Array<string | null> | undefined,
    expected: readonly string[],
  ) => JSON.stringify(actual) === JSON.stringify(expected);
  if (
    !matchesTitles(
      ideasPage.chips,
      IDEA_TOPICS.map(({ label }) => label),
    ) ||
    !matchesTitles(
      ideasPage.allTitles,
      IDEAS.map(({ title }) => title),
    ) ||
    !matchesTitles(
      ideasPage.developerTitles,
      IDEAS.filter(({ tags }) => tags.includes("developer")).map(
        ({ title }) => title,
      ),
    ) ||
    ideasPage.developerPressed !== "true" ||
    !matchesTitles(
      ideasPage.unionTitles,
      IDEAS.filter(({ tags }) =>
        tags.some((tag) => tag === "developer" || tag === "productivity"),
      ).map(({ title }) => title),
    ) ||
    ideasPage.emptyTopicMessage !==
      (emptyTopicLabel ? "No ideas in these topics yet." : null) ||
    ideasPage.restoredCount !== IDEAS.length
  ) {
    throw new Error(
      `Desktop UI idea filters failed: ${JSON.stringify(ideasPage)}`,
    );
  }
  if (
    lastOpenedExternalUrl !==
    `codex://threads/new?prompt=${encodeURIComponent(
      codexTriggerPrompt(IDEAS[0]!.prompt),
    )}`
  ) {
    throw new Error(
      `Idea card opened an unexpected URL: ${lastOpenedExternalUrl}`,
    );
  }

  const returnedTitle = await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector(".header-icon-button")?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return document.querySelector(".triggers-title")?.textContent;
    })()`,
  );
  if (returnedTitle !== "Triggers") {
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
  startDesktopNotifications(triggerServer);

  ipcMain.handle("desktop:get-onboarding-status", getOnboardingStatus);
  ipcMain.handle("desktop:complete-onboarding", async () => {
    try {
      return await completeOnboarding();
    } catch (error) {
      return { completed: false, error: errorMessage(error) } as const;
    }
  });
  ipcMain.handle(
    "desktop:get-macos-notification-permission",
    getMacosNotificationPermission,
  );
  ipcMain.handle(
    "desktop:request-macos-notification-permission",
    requestMacosNotificationPermission,
  );
  ipcMain.handle("desktop:get-status", () => currentStatus(triggerServer!));
  ipcMain.handle(
    "desktop:open-macos-notification-settings",
    openMacosNotificationSettings,
  );
  ipcMain.handle("desktop:get-pending-trigger-navigation", (
    _event,
    expectedTriggerId: unknown,
  ) => {
    const pending = pendingTriggerNavigation;
    if (
      expectedTriggerId === undefined ||
      (typeof expectedTriggerId === "string" &&
        pending?.id === expectedTriggerId)
    ) {
      pendingTriggerNavigation = null;
    }
    return pending;
  });
  ipcMain.handle("desktop:list-triggers", () =>
    listTriggers(triggerServer!),
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
    "desktop:set-macos-notifications-enabled",
    (_event, triggerId: unknown, enabled: unknown) => {
      if (typeof triggerId !== "string" || typeof enabled !== "boolean") {
        throw new Error("Invalid macOS notification update");
      }
      return setMacosNotificationsEnabled(
        triggerServer!,
        triggerId,
        enabled,
      );
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
  ipcMain.handle(
    "desktop:set-codex-options",
    (_event, triggerId: unknown, options: unknown) => {
      if (
        typeof triggerId !== "string" ||
        typeof options !== "object" ||
        options === null ||
        Array.isArray(options)
      ) {
        throw new Error("Invalid Codex options update");
      }
      const update = options as Record<string, unknown>;
      const model = update.model;
      const reasoningEffort = update.reasoningEffort;
      if (
        (model !== undefined && !isCodexModel(model)) ||
        (reasoningEffort !== undefined &&
          !isCodexReasoningEffort(reasoningEffort)) ||
        (model === undefined && reasoningEffort === undefined)
      ) {
        throw new Error("Invalid Codex options update");
      }
      return setCodexOptions(triggerServer!, triggerId, {
        ...(model !== undefined ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
    },
  );
  ipcMain.handle("desktop:delete-trigger", async (_event, triggerId: unknown) => {
    if (typeof triggerId !== "string" || triggerId.trim() === "") {
      throw new Error("Invalid Trigger ID");
    }
    if (!(await triggerServer!.system.deleteTrigger(triggerId))) {
      throw new Error("Trigger not found");
    }
  });
  ipcMain.handle("desktop:open-codex-new-chat", (_event, prompt: unknown) => {
    if (
      prompt !== undefined &&
      (typeof prompt !== "string" || prompt.trim() === "")
    ) {
      throw new Error("Invalid Codex prompt");
    }
    return openCodexNewChat(prompt);
  });
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
  await syncBundledSkillAfterUpdate().catch((error: unknown) => {
    console.error("Codex Triggers skill could not be refreshed", error);
  });
  window = createWindow();
}

async function stopDesktop(): Promise<void> {
  unsubscribeTriggerNotifications?.();
  unsubscribeTriggerNotifications = null;
  unsubscribeDeliveryNotifications?.();
  unsubscribeDeliveryNotifications = null;
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
