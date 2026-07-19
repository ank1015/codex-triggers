import { Ajv, type ValidateFunction } from "ajv";

import type { JsonValue } from "../../domain/types.js";
import { ValidationError } from "../../domain/validation.js";
import type {
  DeliveryService,
  DeliveryServiceDescriptor,
} from "../domain/types.js";

type RegisteredService = {
  service: DeliveryService;
  validateConfig: ValidateFunction;
  validateInput: ValidateFunction;
};

export class DeliveryServiceRegistry {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly services = new Map<string, RegisteredService>();

  constructor(services: DeliveryService[] = []) {
    for (const service of services) this.register(service);
  }

  register(service: DeliveryService): void {
    if (this.services.has(service.type)) {
      throw new Error(`Delivery Service ${service.type} is already registered`);
    }
    this.services.set(service.type, {
      service,
      validateConfig: this.ajv.compile<JsonValue>(service.configSchema),
      validateInput: this.ajv.compile<JsonValue>(service.inputSchema),
    });
  }

  list(): DeliveryServiceDescriptor[] {
    return [...this.services.values()].map(({ service }) => ({
      type: service.type,
      configSchema: service.configSchema,
      inputSchema: service.inputSchema,
    }));
  }

  get(type: string): DeliveryService | null {
    return this.services.get(type)?.service ?? null;
  }

  validateConfig(type: string, config: Record<string, JsonValue>): void {
    const registered = this.services.get(type);
    if (!registered) throw new ValidationError(`Unknown Delivery Service: ${type}`);
    if (!registered.validateConfig(config)) {
      throw new ValidationError(`Invalid configuration for Delivery Service ${type}`, [
        this.ajv.errorsText(registered.validateConfig.errors, { separator: "; " }),
      ]);
    }
  }

  validateInput(type: string, input: Record<string, JsonValue>): void {
    const registered = this.services.get(type);
    if (!registered) throw new Error(`Delivery Service ${type} is not registered`);
    if (!registered.validateInput(input)) {
      throw new Error(
        `Rendered input for Delivery Service ${type} is invalid: ${this.ajv.errorsText(
          registered.validateInput.errors,
          { separator: "; " },
        )}`,
      );
    }
  }
}
