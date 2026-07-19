import type { JsonValue } from "../../domain/types.js";
import {
  asJsonValue,
  isRecord,
  ValidationError,
} from "../../domain/validation.js";
import type {
  ConfiguredDeliveryServiceInput,
  CreateDeliveryInput,
  UpdateDeliveryInput,
} from "./types.js";

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function recordValue(value: unknown, label: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw new ValidationError(`${label} must be an object`);
  return asJsonValue(value, label) as Record<string, JsonValue>;
}

function parseServices(value: unknown): ConfiguredDeliveryServiceInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("services must contain at least one service");
  }
  return value.map((service, index) => {
    if (!isRecord(service)) {
      throw new ValidationError(`services[${index}] must be an object`);
    }
    return {
      type: nonEmptyString(service.type, `services[${index}].type`),
      config: recordValue(service.config ?? {}, `services[${index}].config`),
      input: recordValue(service.input ?? {}, `services[${index}].input`),
    };
  });
}

export function parseCreateDelivery(value: unknown): CreateDeliveryInput {
  if (!isRecord(value)) throw new ValidationError("request body must be an object");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }
  return {
    name: nonEmptyString(value.name, "name"),
    triggerId: nonEmptyString(value.triggerId, "triggerId"),
    enabled: value.enabled ?? true,
    services: parseServices(value.services),
  };
}

export function parseUpdateDelivery(value: unknown): UpdateDeliveryInput {
  if (!isRecord(value)) throw new ValidationError("request body must be an object");
  const update: UpdateDeliveryInput = {};
  if (value.name !== undefined) update.name = nonEmptyString(value.name, "name");
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean");
    }
    update.enabled = value.enabled;
  }
  if (value.services !== undefined) update.services = parseServices(value.services);
  if (value.triggerId !== undefined) {
    throw new ValidationError("A Delivery triggerId cannot be changed");
  }
  return update;
}
