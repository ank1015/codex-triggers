export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = boolean | Record<string, unknown>;

export type TriggerKind = "webhook" | "schedule" | "service";
export type ExecutionKind = "webhook" | "schedule" | "manual" | "service";
export type ExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";

export type Trigger = {
  id: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  macosNotificationsEnabled: boolean;
  activeRevisionId: string;
  createdAt: string;
  updatedAt: string;
};

export type TriggerRevision = {
  id: string;
  triggerId: string;
  version: number;
  code: string;
  outputSchema: JsonSchema;
  timeoutMs: number;
  createdAt: string;
};

export type WebhookEndpoint = {
  id: string;
  triggerId: string;
  tokenHash: string;
  createdAt: string;
  rotatedAt: string | null;
};

export type ScheduleKind = "cron" | "once";

export type TriggerSchedule = {
  id: string;
  triggerId: string;
  kind: ScheduleKind;
  expression: string;
  timezone: string;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Execution = {
  id: string;
  triggerId: string;
  revisionId: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  input: JsonValue;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TriggerOutput = {
  message: string;
  data: JsonValue;
};

export type Notification = {
  id: string;
  triggerId: string;
  executionId: string;
  output: TriggerOutput;
  status: "recorded";
  createdAt: string;
};

export type ExecutionLog = {
  id: number;
  triggerId: string;
  executionId: string;
  level: "debug" | "info" | "warn" | "error";
  values: string[];
  createdAt: string;
};

export type ServiceState = {
  triggerId: string;
  status: "stopped" | "starting" | "running" | "failed";
  restartCount: number;
  lastError: string | null;
  updatedAt: string;
};

export type SerializedWebhookRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string | null;
};

export type JobInput =
  | {
      type: "webhook";
      request: SerializedWebhookRequest;
      receivedAt: string;
    }
  | {
      type: "schedule";
      scheduleId: string;
      scheduledFor: string;
      payload?: JsonValue;
    }
  | {
      type: "manual";
      payload: JsonValue;
      requestedAt: string;
    };

export type ScheduleInput = {
  kind: ScheduleKind;
  expression: string;
  timezone: string;
};

export type CreateTriggerInput = {
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  macosNotificationsEnabled?: boolean;
  code: string;
  outputSchema: JsonSchema;
  timeoutMs: number;
  schedule?: ScheduleInput;
};

export type UpdateTriggerInput = {
  name?: string;
  enabled?: boolean;
  macosNotificationsEnabled?: boolean;
  code?: string;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  schedule?: ScheduleInput;
};

export type TriggerDetails = {
  trigger: Trigger;
  revision: TriggerRevision;
  webhook: Omit<WebhookEndpoint, "tokenHash"> | null;
  schedule: TriggerSchedule | null;
  serviceState: ServiceState | null;
};
