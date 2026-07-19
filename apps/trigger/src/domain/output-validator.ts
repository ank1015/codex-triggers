import { Ajv, type ValidateFunction } from "ajv";

import type {
  JsonSchema,
  JsonValue,
  TriggerOutput,
  TriggerRevision,
} from "./types.js";

export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputValidationError";
  }
}

export class TriggerOutputValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  validate(revision: TriggerRevision, value: unknown): TriggerOutput {
    const validator = this.validatorFor(revision.id, revision.outputSchema);
    if (!validator(value)) {
      throw new OutputValidationError(
        `Trigger output did not match its schema: ${this.ajv.errorsText(
          validator.errors,
          { separator: "; " },
        )}`,
      );
    }
    return value as TriggerOutput;
  }

  assertSchema(id: string, dataSchema: JsonSchema): void {
    this.validatorFor(id, dataSchema);
  }

  private validatorFor(id: string, dataSchema: JsonSchema): ValidateFunction {
    const cached = this.validators.get(id);
    if (cached) return cached;
    const schema = {
      type: "object",
      required: ["message", "data"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1 },
        data: dataSchema,
      },
    };
    const validator = this.ajv.compile<JsonValue>(schema);
    this.validators.set(id, validator);
    return validator;
  }
}
