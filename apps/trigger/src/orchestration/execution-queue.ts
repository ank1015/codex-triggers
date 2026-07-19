import type { JobInput } from "../domain/types.js";
import type { TriggerDatabase } from "../persistence/database.js";
import type { TriggerCodeStore } from "../runtime/code-store.js";
import type { TriggerWorkerHost } from "../runtime/worker-host.js";
import type { NotificationRecorder } from "./notification-recorder.js";

export class ExecutionQueue {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopping = false;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly database: TriggerDatabase,
    private readonly codeStore: TriggerCodeStore,
    private readonly runtime: TriggerWorkerHost,
    private readonly notifications: NotificationRecorder,
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
      const execution = this.database.claimNextExecution();
      if (!execution) return;
      this.active += 1;
      void this.run(execution.id).finally(() => {
        this.active -= 1;
        this.wake();
      });
    }
  }

  private async run(executionId: string): Promise<void> {
    const execution = this.database.getExecution(executionId);
    if (!execution) return;
    const trigger = this.database.getTrigger(execution.triggerId);
    const revision = this.database.getRevision(execution.revisionId);
    if (!trigger || !revision) {
      this.database.finishExecution(
        executionId,
        "failed",
        "Trigger or revision no longer exists",
      );
      return;
    }

    try {
      const modulePath = await this.codeStore.ensure(
        revision.id,
        revision.code,
        trigger.kind,
      );
      const outcome = await this.runtime.executeJob({
        triggerId: trigger.id,
        executionId,
        revision,
        modulePath,
        event: execution.input as unknown as JobInput,
        secrets: this.database.getSecrets(trigger.id),
        callbacks: {
          notify: async (value) =>
            await this.notifications.record({
              triggerId: trigger.id,
              executionId,
              revision,
              value,
            }),
          log: (log) => {
            this.database.addLog({
              triggerId: trigger.id,
              executionId,
              ...log,
            });
          },
        },
      });
      this.database.finishExecution(
        executionId,
        outcome.status,
        outcome.status === "succeeded" ? null : outcome.error,
      );
    } catch (error) {
      this.database.finishExecution(
        executionId,
        "failed",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
    }
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0 || this.database.listExecutions({ limit: 500 }).some((e) => e.status === "queued" || e.status === "running")) {
      if (Date.now() >= deadline) throw new Error("Execution queue did not become idle");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
    const deadline = Date.now() + 10_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
