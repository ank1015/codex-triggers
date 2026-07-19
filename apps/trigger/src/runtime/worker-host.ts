import { Worker } from "node:worker_threads";

import type {
  ExecutionLog,
  JobInput,
  TriggerKind,
  TriggerRevision,
} from "../domain/types.js";

type RuntimeCallbacks = {
  notify(value: unknown): Promise<void>;
  log(input: Omit<ExecutionLog, "id" | "triggerId" | "executionId">): void;
};

type RuntimeOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: string }
  | { status: "timed_out"; error: string };

export type ServiceOutcome =
  | { status: "stopped" }
  | { status: "exited" }
  | { status: "failed"; error: string };

export type ServiceHandle = {
  completion: Promise<ServiceOutcome>;
  stop(reason?: string): Promise<void>;
};

type WorkerMessage =
  | { type: "validated" }
  | { type: "ready" }
  | { type: "completed"; stopped?: boolean }
  | { type: "failed"; error: string }
  | {
      type: "notify";
      requestId: string;
      output: unknown;
    }
  | {
      type: "log";
      level: ExecutionLog["level"];
      values: string[];
      createdAt: string;
    };

const workerUrl = new URL("./worker-runner.mjs", import.meta.url);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export class TriggerWorkerHost {
  constructor(private readonly serviceStopTimeoutMs: number) {}

  async validate(
    modulePath: string,
    kind: TriggerKind,
    timeoutMs = 5_000,
  ): Promise<void> {
    const worker = new Worker(workerUrl, {
      workerData: {
        action: "validate",
        modulePath,
        kind,
        triggerId: "validation",
        executionId: crypto.randomUUID(),
        secrets: {},
      },
      env: {},
      name: "trigger-validation",
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Trigger validation timed out"));
      }, timeoutMs);
      const settle = (operation: () => void) => {
        clearTimeout(timeout);
        operation();
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "validated") {
          settle(resolve);
          void worker.terminate();
        } else if (message.type === "failed") {
          settle(() => reject(new Error(message.error)));
        }
      });
      worker.once("error", (error) => settle(() => reject(error)));
      worker.once("exit", (code) => {
        if (code !== 0) {
          settle(() => reject(new Error(`Validation worker exited with code ${code}`)));
        }
      });
    });
  }

  async executeJob(input: {
    triggerId: string;
    executionId: string;
    revision: TriggerRevision;
    modulePath: string;
    event: JobInput;
    secrets: Record<string, string>;
    callbacks: RuntimeCallbacks;
  }): Promise<RuntimeOutcome> {
    const worker = new Worker(workerUrl, {
      workerData: {
        action: "job",
        modulePath: input.modulePath,
        kind: input.event.type,
        triggerId: input.triggerId,
        executionId: input.executionId,
        input: input.event,
        secrets: input.secrets,
      },
      env: {},
      name: `trigger-job-${input.triggerId}`,
    });

    return await new Promise<RuntimeOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: RuntimeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(outcome);
      };
      const timeout = setTimeout(() => {
        worker.postMessage({ type: "abort", reason: "Execution timed out" });
        void worker.terminate();
        settle({
          status: "timed_out",
          error: `Trigger execution exceeded ${input.revision.timeoutMs}ms`,
        });
      }, input.revision.timeoutMs);

      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "notify") {
          void this.respondToNotification(worker, message, input.callbacks);
        } else if (message.type === "log") {
          input.callbacks.log({
            level: message.level,
            values: message.values,
            createdAt: message.createdAt,
          });
        } else if (message.type === "completed") {
          settle({ status: "succeeded" });
        } else if (message.type === "failed") {
          settle({ status: "failed", error: message.error });
        }
      });
      worker.once("error", (error) =>
        settle({ status: "failed", error: errorMessage(error) }),
      );
      worker.once("exit", (code) => {
        if (!settled && code !== 0) {
          settle({
            status: "failed",
            error: `Trigger worker exited with code ${code}`,
          });
        }
      });
    });
  }

  startService(input: {
    triggerId: string;
    executionId: string;
    modulePath: string;
    secrets: Record<string, string>;
    callbacks: RuntimeCallbacks;
  }): ServiceHandle {
    const worker = new Worker(workerUrl, {
      workerData: {
        action: "service",
        modulePath: input.modulePath,
        kind: "service",
        triggerId: input.triggerId,
        executionId: input.executionId,
        secrets: input.secrets,
      },
      env: {},
      name: `trigger-service-${input.triggerId}`,
    });
    let stopping = false;
    let settled = false;
    let resolveCompletion!: (outcome: ServiceOutcome) => void;
    const completion = new Promise<ServiceOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const settle = (outcome: ServiceOutcome) => {
      if (settled) return;
      settled = true;
      resolveCompletion(outcome);
    };

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "notify") {
        void this.respondToNotification(worker, message, input.callbacks);
      } else if (message.type === "log") {
        input.callbacks.log({
          level: message.level,
          values: message.values,
          createdAt: message.createdAt,
        });
      } else if (message.type === "completed") {
        settle(stopping || message.stopped ? { status: "stopped" } : { status: "exited" });
      } else if (message.type === "failed") {
        settle(
          stopping
            ? { status: "stopped" }
            : { status: "failed", error: message.error },
        );
      }
    });
    worker.once("error", (error) =>
      settle(
        stopping
          ? { status: "stopped" }
          : { status: "failed", error: errorMessage(error) },
      ),
    );
    worker.once("exit", (code) => {
      if (!settled) {
        settle(
          stopping
            ? { status: "stopped" }
            : {
                status: "failed",
                error: `Service worker exited with code ${code}`,
              },
        );
      }
    });

    return {
      completion,
      stop: async (reason = "Service stopped") => {
        if (settled) return;
        stopping = true;
        worker.postMessage({ type: "abort", reason });
        const graceful = await Promise.race([
          completion.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), this.serviceStopTimeoutMs),
          ),
        ]);
        if (!graceful) {
          await worker.terminate();
          settle({ status: "stopped" });
        }
      },
    };
  }

  private async respondToNotification(
    worker: Worker,
    message: Extract<WorkerMessage, { type: "notify" }>,
    callbacks: RuntimeCallbacks,
  ): Promise<void> {
    try {
      await callbacks.notify(message.output);
      worker.postMessage({
        type: "request-result",
        requestId: message.requestId,
        ok: true,
      });
    } catch (error) {
      worker.postMessage({
        type: "request-result",
        requestId: message.requestId,
        ok: false,
        error: errorMessage(error),
      });
    }
  }
}
