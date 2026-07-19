import { asJsonValue } from "../domain/validation.js";
import type { TriggerDatabase } from "../persistence/database.js";
import type { TriggerCodeStore } from "../runtime/code-store.js";
import type {
  ServiceHandle,
  ServiceOutcome,
  TriggerWorkerHost,
} from "../runtime/worker-host.js";
import type { NotificationRecorder } from "./notification-recorder.js";

type RunningService = {
  handle: ServiceHandle;
  executionId: string;
  restartCount: number;
  stopping: boolean;
};

export class ServiceTriggerManager {
  private readonly running = new Map<string, RunningService>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  constructor(
    private readonly database: TriggerDatabase,
    private readonly codeStore: TriggerCodeStore,
    private readonly runtime: TriggerWorkerHost,
    private readonly notifications: NotificationRecorder,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    await Promise.all(
      this.database.listEnabledServices().map(async (trigger) => {
        await this.startOne(trigger.id, 0);
      }),
    );
  }

  async refresh(triggerId: string): Promise<void> {
    this.clearRestart(triggerId);
    await this.stopOne(triggerId, "Service configuration changed");
    const trigger = this.database.getTrigger(triggerId);
    if (!this.stopping && trigger?.kind === "service" && trigger.enabled) {
      await this.startOne(triggerId, 0);
    }
  }

  async startOne(triggerId: string, restartCount = 0): Promise<void> {
    if (this.stopping || this.running.has(triggerId)) return;
    const trigger = this.database.getTrigger(triggerId);
    const revision = this.database.getActiveRevision(triggerId);
    if (!trigger || !revision || trigger.kind !== "service" || !trigger.enabled) {
      return;
    }

    const executionId = crypto.randomUUID();
    this.database.createExecution({
      id: executionId,
      triggerId,
      revisionId: revision.id,
      kind: "service",
      status: "running",
      event: asJsonValue({
        type: "service",
        startedAt: new Date().toISOString(),
      }),
    });
    this.database.setServiceState(triggerId, "starting", restartCount, null);

    try {
      const modulePath = await this.codeStore.ensure(
        revision.id,
        revision.code,
        "service",
      );
      const handle = this.runtime.startService({
        triggerId,
        executionId,
        modulePath,
        secrets: this.database.getSecrets(triggerId),
        callbacks: {
          notify: async (value) =>
            await this.notifications.record({
              triggerId,
              executionId,
              revision,
              value,
            }),
          log: (log) => {
            this.database.addLog({
              triggerId,
              executionId,
              ...log,
            });
          },
        },
      });
      const running: RunningService = {
        handle,
        executionId,
        restartCount,
        stopping: false,
      };
      this.running.set(triggerId, running);
      this.database.setServiceState(triggerId, "running", restartCount, null);
      void handle.completion.then(async (outcome) => {
        await this.onCompletion(triggerId, running, outcome);
      });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      this.database.finishExecution(executionId, "failed", message);
      this.database.setServiceState(triggerId, "failed", restartCount, message);
      this.scheduleRestart(triggerId, restartCount + 1);
    }
  }

  private async onCompletion(
    triggerId: string,
    running: RunningService,
    outcome: ServiceOutcome,
  ): Promise<void> {
    if (this.running.get(triggerId) !== running) return;
    this.running.delete(triggerId);

    if (running.stopping || outcome.status === "stopped") {
      this.database.finishExecution(running.executionId, "succeeded");
      this.database.setServiceState(triggerId, "stopped", running.restartCount, null);
      return;
    }

    const error =
      outcome.status === "failed"
        ? outcome.error
        : "Service Trigger exited without being stopped";
    this.database.finishExecution(running.executionId, "failed", error);
    this.database.setServiceState(
      triggerId,
      "failed",
      running.restartCount,
      error,
    );
    this.scheduleRestart(triggerId, running.restartCount + 1);
  }

  private scheduleRestart(triggerId: string, restartCount: number): void {
    if (this.stopping || this.restartTimers.has(triggerId)) return;
    const trigger = this.database.getTrigger(triggerId);
    if (!trigger?.enabled || trigger.kind !== "service") return;
    const delay = Math.min(1_000 * 2 ** Math.min(restartCount - 1, 6), 60_000);
    const timer = setTimeout(() => {
      this.restartTimers.delete(triggerId);
      void this.startOne(triggerId, restartCount);
    }, delay);
    timer.unref();
    this.restartTimers.set(triggerId, timer);
  }

  private clearRestart(triggerId: string): void {
    const timer = this.restartTimers.get(triggerId);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(triggerId);
  }

  async stopOne(triggerId: string, reason = "Service disabled"): Promise<void> {
    this.clearRestart(triggerId);
    const running = this.running.get(triggerId);
    if (!running) {
      const trigger = this.database.getTrigger(triggerId);
      if (trigger?.kind === "service") {
        this.database.setServiceState(triggerId, "stopped", 0, null);
      }
      return;
    }
    running.stopping = true;
    await running.handle.stop(reason);
    await running.handle.completion;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    await Promise.all(
      [...this.running.keys()].map(async (triggerId) => {
        await this.stopOne(triggerId, "Trigger host shutting down");
      }),
    );
  }
}
