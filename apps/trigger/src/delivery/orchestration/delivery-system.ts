import { randomUUID } from "node:crypto";

import { ValidationError } from "../../domain/validation.js";
import type { TriggerDatabase } from "../../persistence/database.js";
import type {
  ConfiguredDeliveryServiceInput,
  CreateDeliveryInput,
  Delivery,
  DeliveryDetails,
  DeliveryService,
  DeliveryTarget,
  UpdateDeliveryInput,
} from "../domain/types.js";
import { DeliveryServiceRegistry } from "../services/registry.js";
import { DeliveryQueue } from "./delivery-queue.js";

export class DeliverySystem {
  readonly registry: DeliveryServiceRegistry;
  readonly queue: DeliveryQueue;
  private readonly services: DeliveryService[];

  constructor(
    private readonly database: TriggerDatabase,
    services: DeliveryService[],
    concurrency: number,
    intervalMs: number,
  ) {
    this.services = services;
    this.registry = new DeliveryServiceRegistry(services);
    this.queue = new DeliveryQueue(
      database,
      this.registry,
      concurrency,
      intervalMs,
    );
  }

  start(): void {
    this.database.delivery.recoverRunningJobs();
    this.queue.start();
  }

  async stop(): Promise<void> {
    await this.queue.stop();
    await Promise.all(this.services.map((service) => service.stop?.()));
  }

  create(input: CreateDeliveryInput): DeliveryDetails {
    if (!this.database.getTrigger(input.triggerId)) {
      throw new ValidationError("Trigger not found");
    }
    this.validateServices(input.services);

    const id = randomUUID();
    const now = new Date().toISOString();
    const delivery: Delivery = {
      id,
      name: input.name,
      triggerId: input.triggerId,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    return this.database.delivery.createDelivery(
      delivery,
      this.makeTargets(id, input.services, now),
    );
  }

  update(id: string, input: UpdateDeliveryInput): DeliveryDetails | null {
    if (!this.database.delivery.getDelivery(id)) return null;
    if (input.services) this.validateServices(input.services);
    const now = new Date().toISOString();
    return this.database.delivery.updateDelivery(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.services
        ? { targets: this.makeTargets(id, input.services, now) }
        : {}),
    });
  }

  delete(id: string): boolean {
    return this.database.delivery.deleteDelivery(id);
  }

  private validateServices(services: ConfiguredDeliveryServiceInput[]): void {
    for (const service of services) {
      this.registry.validateConfig(service.type, service.config);
    }
  }

  private makeTargets(
    deliveryId: string,
    services: ConfiguredDeliveryServiceInput[],
    now: string,
  ): DeliveryTarget[] {
    return services.map((service) => ({
      id: randomUUID(),
      deliveryId,
      type: service.type,
      config: service.config,
      input: service.input,
      createdAt: now,
      updatedAt: now,
    }));
  }
}
