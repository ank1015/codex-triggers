import type {
  DeliveryService,
  DeliveryServiceRequest,
} from "../../domain/types.js";
import type {
  CodexAppConfig,
  CodexAppController,
  CodexAppInput,
} from "./types.js";

export const CODEX_APP_SERVICE_TYPE = "codex-app";

export const codexAppConfigSchema = {
  type: "object",
  required: ["projectPath", "newThread", "model", "reasoningEffort"],
  additionalProperties: false,
  properties: {
    projectPath: { type: "string" },
    newThread: { type: "boolean" },
    threadId: { type: "string", minLength: 1 },
    model: { type: "string", enum: ["luna", "terra", "sol"] },
    reasoningEffort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh"],
    },
  },
} as const;

export const codexAppInputSchema = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1 },
    attachments: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export class CodexAppDeliveryService implements DeliveryService {
  readonly type = CODEX_APP_SERVICE_TYPE;
  readonly configSchema = codexAppConfigSchema;
  readonly inputSchema = codexAppInputSchema;

  private readonly threadIds = new Map<string, string>();

  constructor(private readonly controller: CodexAppController) {}

  async deliver(request: DeliveryServiceRequest): Promise<void> {
    const config = request.config as unknown as CodexAppConfig;
    const input = request.input as unknown as CodexAppInput;

    const existingThreadId = config.newThread
      ? undefined
      : config.threadId ?? this.threadIds.get(request.configuredServiceId);
    const result = await this.controller.deliver({
      projectPath: config.projectPath,
      ...(existingThreadId ? { threadId: existingThreadId } : {}),
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      prompt: input.prompt,
      attachments: input.attachments ?? [],
      signal: request.signal,
    });

    if (!config.newThread && result.threadId !== existingThreadId) {
      this.threadIds.set(request.configuredServiceId, result.threadId);
      request.updateConfig({ ...request.config, threadId: result.threadId });
    }
  }

  async stop(): Promise<void> {
    await this.controller.shutdown?.();
  }
}
