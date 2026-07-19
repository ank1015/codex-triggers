import { Cron } from "croner";

import type {
  CreateTriggerInput,
  JsonSchema,
  JsonValue,
  ScheduleInput,
  TriggerKind,
  UpdateTriggerInput,
} from "./types.js";

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown, label = "value"): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new ValidationError(`${label} must be JSON-serializable`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseKind(value: unknown): TriggerKind {
  if (value === "webhook" || value === "schedule" || value === "service") {
    return value;
  }
  throw new ValidationError("kind must be webhook, schedule, or service");
}

function parseOutputSchema(value: unknown): JsonSchema {
  if (value === undefined) return true;
  if (typeof value === "boolean" || isRecord(value)) return value;
  throw new ValidationError("outputSchema must be a JSON Schema object or boolean");
}

function parseTimeout(value: unknown, kind: TriggerKind): number {
  const fallback = kind === "service" ? 0 : 30_000;
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || typeof value !== "number") {
    throw new ValidationError("timeoutMs must be an integer");
  }
  if (kind === "service") {
    if (value !== 0) {
      throw new ValidationError("Service Triggers must use timeoutMs 0");
    }
    return 0;
  }
  if (value < 100 || value > 300_000) {
    throw new ValidationError("timeoutMs must be between 100 and 300000");
  }
  return value;
}

export function parseSchedule(value: unknown): ScheduleInput {
  if (!isRecord(value)) throw new ValidationError("schedule is required");
  const kind = value.kind;
  if (kind !== "cron" && kind !== "once") {
    throw new ValidationError("schedule.kind must be cron or once");
  }
  const expression = nonEmptyString(value.expression, "schedule.expression");
  const timezone =
    value.timezone === undefined
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : nonEmptyString(value.timezone, "schedule.timezone");

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ValidationError("schedule.timezone must be a valid IANA timezone");
  }

  if (kind === "once") {
    const date = new Date(expression);
    if (Number.isNaN(date.getTime())) {
      throw new ValidationError(
        "A one-time schedule expression must be an ISO-8601 timestamp",
      );
    }
  } else {
    try {
      const cron = new Cron(expression, { paused: true, timezone });
      cron.stop();
    } catch {
      throw new ValidationError("schedule.expression must be a valid cron expression");
    }
  }

  return { kind, expression, timezone };
}

export function parseCreateTrigger(value: unknown): CreateTriggerInput {
  if (!isRecord(value)) throw new ValidationError("request body must be an object");
  const kind = parseKind(value.kind);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }

  const result: CreateTriggerInput = {
    name: nonEmptyString(value.name, "name"),
    kind,
    enabled: value.enabled ?? true,
    code: nonEmptyString(value.code, "code"),
    outputSchema: parseOutputSchema(value.outputSchema),
    timeoutMs: parseTimeout(value.timeoutMs, kind),
  };

  if (kind === "schedule") result.schedule = parseSchedule(value.schedule);
  if (kind !== "schedule" && value.schedule !== undefined) {
    throw new ValidationError("schedule is only valid for Scheduled Triggers");
  }
  return result;
}

export function parseUpdateTrigger(
  value: unknown,
  kind: TriggerKind,
): UpdateTriggerInput {
  if (!isRecord(value)) throw new ValidationError("request body must be an object");
  const result: UpdateTriggerInput = {};
  if (value.name !== undefined) result.name = nonEmptyString(value.name, "name");
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean");
    }
    result.enabled = value.enabled;
  }
  if (value.code !== undefined) result.code = nonEmptyString(value.code, "code");
  if (value.outputSchema !== undefined) {
    result.outputSchema = parseOutputSchema(value.outputSchema);
  }
  if (value.timeoutMs !== undefined) {
    result.timeoutMs = parseTimeout(value.timeoutMs, kind);
  }
  if (value.schedule !== undefined) {
    if (kind !== "schedule") {
      throw new ValidationError("schedule is only valid for Scheduled Triggers");
    }
    result.schedule = parseSchedule(value.schedule);
  }
  if (value.kind !== undefined) {
    throw new ValidationError("Trigger kind cannot be changed");
  }
  return result;
}
