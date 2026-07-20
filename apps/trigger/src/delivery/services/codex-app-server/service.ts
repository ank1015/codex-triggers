import type {
  DeliveryService,
  DeliveryServiceRequest,
} from "../../domain/types.js";
import type {
  CodexAppServerConfig,
  CodexAppServerController,
  CodexAppServerInput,
} from "./types.js";

export const CODEX_APP_SERVER_SERVICE_TYPE = "codex-app-server";

export const codexAppServerConfigSchema = {
  type: "object",
  required: [
    "projectPath",
    "newThread",
    "model",
    "reasoningEffort",
    "threadMode",
  ],
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
    threadMode: {
      type: "string",
      enum: ["persistent", "ephemeral"],
    },
  },
  allOf: [
    {
      if: {
        properties: { threadMode: { const: "ephemeral" } },
        required: ["threadMode"],
      },
      then: {
        properties: { newThread: { const: true } },
        not: { required: ["threadId"] },
      },
    },
  ],
} as const;

export const codexAppServerInputSchema = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1 },
    images: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export class CodexAppServerDeliveryService implements DeliveryService {
  readonly type = CODEX_APP_SERVER_SERVICE_TYPE;
  readonly configSchema = codexAppServerConfigSchema;
  readonly inputSchema = codexAppServerInputSchema;

  private readonly threadIds = new Map<string, string>();
  private readonly lockTails = new Map<string, Promise<void>>();

  constructor(private readonly controller: CodexAppServerController) {}

  async deliver(
    request: DeliveryServiceRequest,
  ): Promise<{ threadId: string } | void> {
    return await this.withTargetLock(request.configuredServiceId, async () => {
      const config = request.config as unknown as CodexAppServerConfig;
      const input = request.input as unknown as CodexAppServerInput;
      const existingThreadId =
        config.threadMode === "persistent" && !config.newThread
          ? config.threadId ?? this.threadIds.get(request.configuredServiceId)
          : undefined;
      const result = await this.controller.deliver({
        projectPath: config.projectPath,
        ...(existingThreadId ? { threadId: existingThreadId } : {}),
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        threadMode: config.threadMode,
        prompt: input.prompt,
        images: input.images ?? [],
        signal: request.signal,
      });

      if (
        config.threadMode === "persistent" &&
        !config.newThread &&
        result.threadId !== existingThreadId
      ) {
        this.threadIds.set(request.configuredServiceId, result.threadId);
        request.updateConfig({ ...request.config, threadId: result.threadId });
      }

      return config.threadMode === "persistent"
        ? { threadId: result.threadId }
        : undefined;
    });
  }

  async stop(): Promise<void> {
    await this.controller.shutdown?.();
  }

  private async withTargetLock<T>(
    targetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lockTails.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.lockTails.set(targetId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lockTails.get(targetId) === tail) {
        this.lockTails.delete(targetId);
      }
    }
  }
}
