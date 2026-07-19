export const CODEX_APP_SERVER_MODELS = ["luna", "terra", "sol"] as const;
export const CODEX_APP_SERVER_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const CODEX_APP_SERVER_THREAD_MODES = [
  "persistent",
  "ephemeral",
] as const;

export type CodexAppServerModel =
  (typeof CODEX_APP_SERVER_MODELS)[number];
export type CodexAppServerReasoningEffort =
  (typeof CODEX_APP_SERVER_REASONING_EFFORTS)[number];
export type CodexAppServerThreadMode =
  (typeof CODEX_APP_SERVER_THREAD_MODES)[number];

export type CodexAppServerConfig = {
  projectPath: string;
  newThread: boolean;
  threadId?: string;
  model: CodexAppServerModel;
  reasoningEffort: CodexAppServerReasoningEffort;
  threadMode: CodexAppServerThreadMode;
};

export type CodexAppServerInput = {
  prompt: string;
  images?: string[];
};

export type CodexAppServerRunRequest = {
  projectPath: string;
  threadId?: string;
  model: CodexAppServerModel;
  reasoningEffort: CodexAppServerReasoningEffort;
  threadMode: CodexAppServerThreadMode;
  prompt: string;
  images: string[];
  signal: AbortSignal;
};

export type CodexAppServerRunResult = {
  threadId: string;
};

export interface CodexAppServerController {
  deliver(
    request: CodexAppServerRunRequest,
  ): Promise<CodexAppServerRunResult>;
  shutdown?(): Promise<void>;
}
