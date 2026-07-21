import type { Notification, TriggerRevision } from "../domain/types.js";
import { TriggerOutputValidator } from "../domain/output-validator.js";
import { asJsonValue } from "../domain/validation.js";
import type { TriggerDatabase } from "../persistence/database.js";

export class NotificationRecorder {
  private readonly validator = new TriggerOutputValidator();
  private readonly listeners = new Set<
    (notification: Notification) => void | Promise<void>
  >();

  constructor(private readonly database: TriggerDatabase) {}

  validateSchema(revisionId: string, schema: TriggerRevision["outputSchema"]): void {
    this.validator.assertSchema(revisionId, schema);
  }

  subscribe(
    listener: (notification: Notification) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async record(input: {
    triggerId: string;
    executionId: string;
    revision: TriggerRevision;
    value: unknown;
  }): Promise<void> {
    const serialized = asJsonValue(input.value, "Trigger output");
    const output = this.validator.validate(input.revision, serialized);
    const notification: Notification = {
      id: crypto.randomUUID(),
      triggerId: input.triggerId,
      executionId: input.executionId,
      output,
      status: "recorded",
      createdAt: new Date().toISOString(),
    };
    this.database.addNotification(notification);
    for (const listener of this.listeners) {
      void Promise.resolve(listener(notification)).catch((error: unknown) => {
        console.error("Trigger notification listener failed", error);
      });
    }
  }
}
