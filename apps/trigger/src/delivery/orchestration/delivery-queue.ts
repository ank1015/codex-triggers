import { asJsonValue } from "../../domain/validation.js";
import type { TriggerDatabase } from "../../persistence/database.js";
import { renderDeliveryInput } from "../domain/template-renderer.js";
import type { DeliveryJob } from "../domain/types.js";
import type { DeliveryServiceRegistry } from "../services/registry.js";

export class DeliveryQueue {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopping = false;
  private drainPromise: Promise<void> | null = null;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: TriggerDatabase,
    private readonly registry: DeliveryServiceRegistry,
    private readonly concurrency: number,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.stopping || this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopping && this.active < this.concurrency) {
      const job = this.database.delivery.claimNextJob();
      if (!job) return;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.wake();
      });
    }
  }

  private async run(job: DeliveryJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const notification = this.database.getNotification(job.notificationId);
      if (!notification) throw new Error("Notification no longer exists");

      const service = this.registry.get(job.serviceType);
      if (!service) {
        throw new Error(`Delivery Service ${job.serviceType} is not registered`);
      }

      this.registry.validateConfig(job.serviceType, job.config);
      const input = renderDeliveryInput(job.input, notification.output);
      this.registry.validateInput(job.serviceType, input);
      const value = await service.deliver({
        configuredServiceId: job.configuredServiceId,
        config: job.config,
        input,
        notification,
        signal: controller.signal,
        updateConfig: (config) => {
          this.registry.validateConfig(job.serviceType, config);
          this.database.delivery.updateTargetConfig(
            job.configuredServiceId,
            config,
          );
        },
      });
      const result = value === undefined ? null : asJsonValue(value, "Delivery result");
      this.database.delivery.finishJob(job.id, "succeeded", result, null);
    } catch (error) {
      this.database.delivery.finishJob(
        job.id,
        "failed",
        null,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.controllers.delete(job.id);
    }
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.active > 0 ||
      this.database.delivery
        .listJobs({ limit: 500 })
        .some((job) => job.status === "queued" || job.status === "running")
    ) {
      if (Date.now() >= deadline) {
        throw new Error("Delivery queue did not become idle");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await this.drainPromise;
    const deadline = Date.now() + 10_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
