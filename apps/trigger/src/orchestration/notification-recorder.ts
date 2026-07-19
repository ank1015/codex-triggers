import type { TriggerRevision } from "../domain/types.js";
import { TriggerOutputValidator } from "../domain/output-validator.js";
import { asJsonValue } from "../domain/validation.js";
import type { TriggerDatabase } from "../persistence/database.js";

export class NotificationRecorder {
  private readonly validator = new TriggerOutputValidator();

  constructor(private readonly database: TriggerDatabase) {}

  validateSchema(revisionId: string, schema: TriggerRevision["outputSchema"]): void {
    this.validator.assertSchema(revisionId, schema);
  }

  async record(input: {
    triggerId: string;
    executionId: string;
    revision: TriggerRevision;
    value: unknown;
  }): Promise<void> {
    const serialized = asJsonValue(input.value, "Trigger output");
    const output = this.validator.validate(input.revision, serialized);
    this.database.addNotification({
      id: crypto.randomUUID(),
      triggerId: input.triggerId,
      executionId: input.executionId,
      output,
      status: "recorded",
      createdAt: new Date().toISOString(),
    });
  }
}
