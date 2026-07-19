import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Codex,
  type Input,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";

import type { JsonValue } from "../../domain/types.js";
import type {
  DeliveryService,
  DeliveryServiceRequest,
} from "../domain/types.js";

const MODEL_IDS = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
} as const;

type ModelAlias = keyof typeof MODEL_IDS;
type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

type CodexCliConfig = {
  projectPath: string;
  newThread: boolean;
  threadId?: string;
  model: ModelAlias;
  reasoningEffort: ReasoningEffort;
  sandboxMode?: SandboxMode;
  networkAccessEnabled?: boolean;
  timeoutMs?: number;
};

type CodexCliInput = {
  prompt: string;
  images?: string[];
};

type CodexThread = {
  readonly id: string | null;
  runStreamed(
    input: Input,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
};

type CodexClientFactory = (reasoningEffort: ReasoningEffort) => CodexClient;

export const CODEX_CLI_SERVICE_TYPE = "codex-cli";

export const codexCliConfigSchema = {
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
      enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    sandboxMode: {
      type: "string",
      enum: ["read-only", "workspace-write", "danger-full-access"],
      default: "danger-full-access",
    },
    networkAccessEnabled: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 1 },
  },
} as const;

export const codexCliInputSchema = {
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

export class CodexCliDeliveryService implements DeliveryService {
  readonly type = CODEX_CLI_SERVICE_TYPE;
  readonly configSchema = codexCliConfigSchema;
  readonly inputSchema = codexCliInputSchema;

  private readonly threadIds = new Map<string, string>();
  private readonly lockTails = new Map<string, Promise<void>>();

  constructor(
    private readonly defaultProjectPath: string,
    private readonly createClient: CodexClientFactory = (reasoningEffort) =>
      new Codex({
        config: { model_reasoning_effort: reasoningEffort },
      }),
  ) {}

  async deliver(request: DeliveryServiceRequest): Promise<void> {
    await this.withTargetLock(request.configuredServiceId, async () => {
      const config = request.config as unknown as CodexCliConfig;
      const input = request.input as unknown as CodexCliInput;
      const projectPath = await this.resolveProjectPath(config.projectPath);
      const existingThreadId =
        config.threadId ?? this.threadIds.get(request.configuredServiceId);
      const client = this.createClient(config.reasoningEffort);
      const threadOptions: ThreadOptions = {
        model: MODEL_IDS[config.model],
        workingDirectory: projectPath,
        skipGitRepoCheck: config.projectPath.trim() === "",
        sandboxMode: config.sandboxMode ?? "danger-full-access",
        approvalPolicy: "never",
        ...(config.networkAccessEnabled === undefined
          ? {}
          : { networkAccessEnabled: config.networkAccessEnabled }),
      };
      const thread =
        !config.newThread && existingThreadId
          ? client.resumeThread(existingThreadId, threadOptions)
          : client.startThread(threadOptions);
      const codexInput: Input = input.images?.length
        ? [
            { type: "text", text: input.prompt },
            ...input.images.map((path) => ({
              type: "local_image" as const,
              path,
            })),
          ]
        : input.prompt;
      const signal = this.deliverySignal(request.signal, config.timeoutMs);
      const { events } = await thread.runStreamed(codexInput, { signal });
      let failure: string | null = null;
      let completed = false;
      let persistedThreadId = existingThreadId;

      for await (const event of events) {
        if (!config.newThread && thread.id && thread.id !== persistedThreadId) {
          this.rememberThread(request, thread.id);
          persistedThreadId = thread.id;
        }
        if (event.type === "turn.failed") failure = event.error.message;
        if (event.type === "error") failure = event.message;
        if (event.type === "turn.completed") completed = true;
      }

      if (!config.newThread && thread.id && thread.id !== persistedThreadId) {
        this.rememberThread(request, thread.id);
      }
      if (failure) throw new Error(failure);
      if (!completed) throw new Error("Codex run ended without completing the turn");
    });
  }

  private rememberThread(request: DeliveryServiceRequest, threadId: string): void {
    this.threadIds.set(request.configuredServiceId, threadId);
    request.updateConfig({ ...request.config, threadId });
  }

  private async resolveProjectPath(projectPath: string): Promise<string> {
    if (projectPath.trim() === "") {
      const path = resolve(this.defaultProjectPath);
      await mkdir(path, { recursive: true });
      return path;
    }
    const path = resolve(projectPath);
    const details = await stat(path).catch(() => null);
    if (!details?.isDirectory()) {
      throw new Error(`Codex projectPath is not a directory: ${path}`);
    }
    return path;
  }

  private deliverySignal(hostSignal: AbortSignal, timeoutMs?: number): AbortSignal {
    return timeoutMs === undefined
      ? hostSignal
      : AbortSignal.any([hostSignal, AbortSignal.timeout(timeoutMs)]);
  }

  private async withTargetLock<T>(
    targetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lockTails.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.lockTails.set(targetId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lockTails.get(targetId) === tail) this.lockTails.delete(targetId);
    }
  }
}

export type {
  CodexCliConfig,
  CodexCliInput,
  CodexClient,
  CodexClientFactory,
  CodexThread,
  ModelAlias,
  ReasoningEffort,
};
