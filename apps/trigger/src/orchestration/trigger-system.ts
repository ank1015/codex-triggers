import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { TriggerConfig } from "../config/index.js";
import type {
  CreateDeliveryInput,
  DeliveryDetails,
  DeliveryService,
} from "../delivery/domain/types.js";
import { DeliverySystem } from "../delivery/orchestration/delivery-system.js";
import {
  CodexAppDeliveryService,
  ElectronCodexAppController,
} from "../delivery/services/codex-app/index.js";
import {
  CodexAppServerDeliveryService,
  ProcessCodexAppServerController,
} from "../delivery/services/codex-app-server/index.js";
import { CodexCliDeliveryService } from "../delivery/services/codex-cli-service.js";
import type {
  CreateTriggerInput,
  Execution,
  JsonValue,
  ScheduleInput,
  SerializedWebhookRequest,
  Trigger,
  TriggerDetails,
  TriggerRevision,
  TriggerSchedule,
  UpdateTriggerInput,
  WebhookEndpoint,
} from "../domain/types.js";
import { asJsonValue, ValidationError } from "../domain/validation.js";
import {
  TailscaleWebhookTunnel,
  type WebhookTunnel,
  type WebhookTunnelStatus,
} from "../integrations/tailscale-webhook-tunnel.js";
import { TriggerDatabase } from "../persistence/database.js";
import { TriggerCodeStore } from "../runtime/code-store.js";
import { TriggerWorkerHost } from "../runtime/worker-host.js";
import { ExecutionQueue } from "./execution-queue.js";
import { NotificationRecorder } from "./notification-recorder.js";
import { nextScheduleRun, TriggerScheduler } from "./scheduler.js";
import { ServiceTriggerManager } from "./service-manager.js";

export type CreatedTrigger = {
  details: TriggerDetails;
  webhookToken?: string;
  webhookUrl?: string;
};

export const BUILT_IN_DELIVERY_SERVICE_TYPES = [
  "codex-cli",
  "codex-app",
  "codex-app-server",
] as const;

export type BuiltInDeliveryServiceType =
  (typeof BUILT_IN_DELIVERY_SERVICE_TYPES)[number];

export type TriggerSystemOptions = {
  deliveryServices?: DeliveryService[];
  builtInDeliveryServices?: readonly BuiltInDeliveryServiceType[];
  webhookTunnel?: WebhookTunnel;
};

export type CreateTriggerSystemInput = {
  trigger: CreateTriggerInput;
  delivery: Omit<CreateDeliveryInput, "triggerId">;
};

export type CreatedTriggerSystem = {
  trigger: CreatedTrigger;
  delivery: DeliveryDetails;
};

function webhookHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(webhookHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class TriggerSystem {
  readonly database: TriggerDatabase;
  readonly codeStore: TriggerCodeStore;
  readonly runtime: TriggerWorkerHost;
  readonly notifications: NotificationRecorder;
  readonly delivery: DeliverySystem;
  readonly queue: ExecutionQueue;
  readonly scheduler: TriggerScheduler;
  readonly services: ServiceTriggerManager;
  readonly webhookTunnel: WebhookTunnel;
  private started = false;
  private tunnelPublicBaseUrl: string | null = null;

  constructor(
    readonly config: TriggerConfig,
    options: TriggerSystemOptions = {},
  ) {
    this.database = new TriggerDatabase(resolve(config.dataDir, "trigger.db"));
    this.codeStore = new TriggerCodeStore(config.dataDir);
    this.runtime = new TriggerWorkerHost(config.serviceStopTimeoutMs);
    this.notifications = new NotificationRecorder(this.database);
    const deliveryServices = new Map<string, DeliveryService>();
    const enabledBuiltIns = new Set(
      options.builtInDeliveryServices ?? BUILT_IN_DELIVERY_SERVICE_TYPES,
    );
    const builtInServices: DeliveryService[] = [];
    if (enabledBuiltIns.has("codex-cli")) {
      builtInServices.push(
        new CodexCliDeliveryService(resolve(config.dataDir, "codex-workspace")),
      );
    }
    if (enabledBuiltIns.has("codex-app")) {
      builtInServices.push(
        new CodexAppDeliveryService(
          new ElectronCodexAppController({
            appPath: config.codexAppPath,
          }),
        ),
      );
    }
    if (enabledBuiltIns.has("codex-app-server")) {
      builtInServices.push(
        new CodexAppServerDeliveryService(
          new ProcessCodexAppServerController({
            defaultProjectPath: resolve(config.dataDir, "codex-workspace"),
          }),
        ),
      );
    }
    for (const service of [...builtInServices, ...(options.deliveryServices ?? [])]) {
      deliveryServices.set(service.type, service);
    }
    this.delivery = new DeliverySystem(
      this.database,
      [...deliveryServices.values()],
      config.jobConcurrency,
      config.queueIntervalMs,
    );
    this.queue = new ExecutionQueue(
      this.database,
      this.codeStore,
      this.runtime,
      this.notifications,
      config.jobConcurrency,
      config.queueIntervalMs,
    );
    this.scheduler = new TriggerScheduler(
      this.database,
      this.queue,
      config.schedulerIntervalMs,
    );
    this.services = new ServiceTriggerManager(
      this.database,
      this.codeStore,
      this.runtime,
      this.notifications,
    );
    this.webhookTunnel =
      options.webhookTunnel ?? new TailscaleWebhookTunnel({ port: config.publicPort });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.config.dataDir, { recursive: true });
    this.database.recoverRunningExecutions();
    this.delivery.start();
    this.queue.start();
    this.scheduler.start();
    await this.services.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.scheduler.stop();
    await this.services.stop();
    await this.queue.stop();
    await this.delivery.stop();
    this.started = false;
  }

  close(): void {
    this.database.close();
  }

  async createTrigger(input: CreateTriggerInput): Promise<CreatedTrigger> {
    const triggerId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.prepareRevision(revisionId, input.code, input.kind, input.outputSchema);

    const revision: TriggerRevision = {
      id: revisionId,
      triggerId,
      version: 1,
      code: input.code,
      outputSchema: input.outputSchema,
      timeoutMs: input.timeoutMs,
      createdAt: now,
    };
    const trigger: Trigger = {
      id: triggerId,
      name: input.name,
      kind: input.kind,
      enabled: input.enabled,
      activeRevisionId: revisionId,
      createdAt: now,
      updatedAt: now,
    };

    let webhook: WebhookEndpoint | undefined;
    let webhookToken: string | undefined;
    if (input.kind === "webhook") {
      webhookToken = randomBytes(32).toString("base64url");
      webhook = {
        id: `whk_${randomBytes(12).toString("base64url")}`,
        triggerId,
        tokenHash: webhookHash(webhookToken),
        createdAt: now,
        rotatedAt: null,
      };
    }

    let schedule: TriggerSchedule | undefined;
    if (input.kind === "schedule") {
      if (!input.schedule) throw new ValidationError("schedule is required");
      schedule = this.makeSchedule(triggerId, input.schedule, now);
    }

    try {
      this.database.createTrigger({
        trigger,
        revision,
        ...(webhook ? { webhook } : {}),
        ...(schedule ? { schedule } : {}),
      });
    } catch (error) {
      await this.codeStore.remove(revisionId);
      throw error;
    }

    if (input.kind === "service" && input.enabled) {
      await this.services.refresh(triggerId);
    }
    const details = this.database.getDetails(triggerId)!;
    const result: CreatedTrigger = { details };
    if (webhook && webhookToken) {
      result.webhookToken = webhookToken;
      result.webhookUrl = this.webhookUrl(webhook.id, webhookToken);
    }
    return result;
  }

  async updateTrigger(
    triggerId: string,
    update: UpdateTriggerInput,
  ): Promise<TriggerDetails | null> {
    const current = this.database.getDetails(triggerId);
    if (!current) return null;

    const revisionChanged =
      update.code !== undefined ||
      update.outputSchema !== undefined ||
      update.timeoutMs !== undefined;
    if (revisionChanged) {
      const revisionId = crypto.randomUUID();
      const code = update.code ?? current.revision.code;
      const outputSchema = update.outputSchema ?? current.revision.outputSchema;
      const timeoutMs = update.timeoutMs ?? current.revision.timeoutMs;
      await this.prepareRevision(revisionId, code, current.trigger.kind, outputSchema);
      const revision: TriggerRevision = {
        id: revisionId,
        triggerId,
        version: this.database.nextRevisionVersion(triggerId),
        code,
        outputSchema,
        timeoutMs,
        createdAt: new Date().toISOString(),
      };
      try {
        this.database.addRevision(revision);
      } catch (error) {
        await this.codeStore.remove(revisionId);
        throw error;
      }
    }

    if (update.name !== undefined || update.enabled !== undefined) {
      this.database.updateTriggerMetadata(triggerId, {
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
      });
    }

    if (update.schedule) {
      this.database.updateSchedule(triggerId, {
        ...update.schedule,
        nextRunAt: nextScheduleRun(update.schedule),
      });
    }

    if (current.trigger.kind === "service") {
      await this.services.refresh(triggerId);
    }
    return this.database.getDetails(triggerId);
  }

  async deleteTrigger(triggerId: string): Promise<boolean> {
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger) return false;
    const revisions = this.database.listRevisions(triggerId);
    if (trigger.kind === "service") {
      await this.services.stopOne(triggerId, "Service Trigger deleted");
    }
    const deleted = this.database.deleteTrigger(triggerId);
    if (deleted) {
      await Promise.all(
        revisions.map(({ id }) => this.codeStore.remove(id)),
      );
    }
    return deleted;
  }

  async createTriggerSystem(
    input: CreateTriggerSystemInput,
  ): Promise<CreatedTriggerSystem> {
    this.delivery.validateServiceConfigurations(input.delivery.services);
    const shouldEnableTrigger = input.trigger.enabled;
    const trigger = await this.createTrigger({
      ...input.trigger,
      enabled: false,
    });

    try {
      const delivery = this.delivery.create({
        ...input.delivery,
        triggerId: trigger.details.trigger.id,
      });
      if (shouldEnableTrigger) {
        const details = await this.updateTrigger(trigger.details.trigger.id, {
          enabled: true,
        });
        if (!details) throw new Error("Created Trigger could not be enabled");
        trigger.details = details;
      }
      return { trigger, delivery };
    } catch (error) {
      await this.deleteTrigger(trigger.details.trigger.id);
      throw error;
    }
  }

  async setServiceEnabled(
    triggerId: string,
    enabled: boolean,
  ): Promise<TriggerDetails | null> {
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger) return null;
    if (trigger.kind !== "service") {
      throw new ValidationError("Only Service Triggers can be started or stopped");
    }
    this.database.updateTriggerMetadata(triggerId, { enabled });
    await this.services.refresh(triggerId);
    return this.database.getDetails(triggerId);
  }

  async getWebhookTunnelStatus(): Promise<WebhookTunnelStatus> {
    const status = await this.webhookTunnel.status();
    if (!status.error) {
      this.tunnelPublicBaseUrl = status.enabled ? status.publicWebhookUrl : null;
    }
    return status;
  }

  async setWebhookTunnelEnabled(enabled: boolean): Promise<WebhookTunnelStatus> {
    const status = await this.webhookTunnel.setEnabled(enabled);
    this.tunnelPublicBaseUrl = status.enabled ? status.publicWebhookUrl : null;
    return status;
  }

  async getPublicWebhookUrlStatus(): Promise<{
    publicWebhookUrl: string | null;
    error: string | null;
  }> {
    const status = await this.getWebhookTunnelStatus();
    const publicWebhookUrl = status.publicWebhookUrl ?? this.config.publicBaseUrl;
    return {
      publicWebhookUrl,
      error:
        publicWebhookUrl !== null
          ? null
          : status.error ?? "Tailscale webhook tunnel has not been started",
    };
  }

  async activateRevision(
    triggerId: string,
    revisionId: string,
  ): Promise<TriggerDetails | null> {
    const trigger = this.database.activateRevision(triggerId, revisionId);
    if (!trigger) return null;
    if (trigger.kind === "service") await this.services.refresh(triggerId);
    return this.database.getDetails(triggerId);
  }

  rotateWebhook(triggerId: string): CreatedTrigger | null {
    const trigger = this.database.getTrigger(triggerId);
    const webhook = this.database.getWebhookByTrigger(triggerId);
    if (!trigger || !webhook) return null;
    const webhookToken = randomBytes(32).toString("base64url");
    this.database.rotateWebhook(webhook.id, webhookHash(webhookToken));
    return {
      details: this.database.getDetails(triggerId)!,
      webhookToken,
      webhookUrl: this.webhookUrl(webhook.id, webhookToken),
    };
  }

  acceptWebhook(input: {
    endpointId: string;
    token: string;
    request: SerializedWebhookRequest;
  }): Execution | null {
    const webhook = this.database.getWebhookById(input.endpointId);
    if (!webhook || !tokenMatches(input.token, webhook.tokenHash)) return null;
    const trigger = this.database.getTrigger(webhook.triggerId);
    if (!trigger?.enabled || trigger.kind !== "webhook") return null;
    const execution = this.database.createExecution({
      id: crypto.randomUUID(),
      triggerId: trigger.id,
      revisionId: trigger.activeRevisionId,
      kind: "webhook",
      event: asJsonValue({
        type: "webhook",
        request: input.request,
        receivedAt: new Date().toISOString(),
      }),
    });
    this.queue.wake();
    return execution;
  }

  runManually(triggerId: string, payload: JsonValue): Execution | null {
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger) return null;
    if (trigger.kind === "service") {
      throw new ValidationError("Service Triggers are started and stopped, not run manually");
    }
    const event =
      trigger.kind === "webhook"
        ? asJsonValue({
            type: "webhook",
            request: {
              method: "POST",
              url: "http://trigger.local/hooks/v1/manual",
              headers: { "content-type": "application/json" },
              bodyBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
            },
            receivedAt: new Date().toISOString(),
          })
        : asJsonValue({
            type: "schedule",
            scheduleId: this.database.getScheduleByTrigger(triggerId)?.id ?? "manual",
            scheduledFor: new Date().toISOString(),
            payload,
          });
    const execution = this.database.createExecution({
      id: crypto.randomUUID(),
      triggerId,
      revisionId: trigger.activeRevisionId,
      kind: "manual",
      event,
    });
    this.queue.wake();
    return execution;
  }

  async setSecret(triggerId: string, name: string, value: string): Promise<string[]> {
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger) throw new ValidationError("Trigger not found");
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new ValidationError(
        "Secret name must start with a letter and contain only A-Z, 0-9, and _",
      );
    }
    this.database.setSecret(triggerId, name, value);
    if (trigger.kind === "service") await this.services.refresh(triggerId);
    return this.database.listSecretNames(triggerId);
  }

  async deleteSecret(triggerId: string, name: string): Promise<boolean> {
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger) throw new ValidationError("Trigger not found");
    const deleted = this.database.deleteSecret(triggerId, name);
    if (deleted && trigger.kind === "service") await this.services.refresh(triggerId);
    return deleted;
  }

  private async prepareRevision(
    revisionId: string,
    code: string,
    kind: Trigger["kind"],
    outputSchema: TriggerRevision["outputSchema"],
  ): Promise<void> {
    try {
      this.notifications.validateSchema(revisionId, outputSchema);
    } catch (error) {
      throw new ValidationError("outputSchema is not a valid JSON Schema", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    const path = await this.codeStore.compile(revisionId, code, kind);
    try {
      await this.runtime.validate(path, kind);
    } catch (error) {
      await this.codeStore.remove(revisionId);
      throw new ValidationError("Trigger code does not implement the required contract", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }

  private makeSchedule(
    triggerId: string,
    input: ScheduleInput,
    now: string,
  ): TriggerSchedule {
    return {
      id: `sch_${randomBytes(12).toString("base64url")}`,
      triggerId,
      kind: input.kind,
      expression: input.expression,
      timezone: input.timezone,
      nextRunAt: nextScheduleRun(input),
      createdAt: now,
      updatedAt: now,
    };
  }

  private webhookUrl(endpointId: string, token: string): string {
    const path = `hooks/v1/${endpointId}/${token}`;
    const configuredBase =
      this.tunnelPublicBaseUrl ??
      this.config.publicBaseUrl ??
      `http://${this.config.publicHost}:${this.config.publicPort}`;
    const base = configuredBase.endsWith("/")
      ? configuredBase
      : `${configuredBase}/`;
    return new URL(path, base).toString();
  }
}
