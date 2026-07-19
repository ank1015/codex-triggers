export const CODEX_APP_MODELS = ["luna", "terra", "sol"] as const;
export const CODEX_APP_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CodexAppModel = (typeof CODEX_APP_MODELS)[number];
export type CodexAppReasoningEffort =
  (typeof CODEX_APP_REASONING_EFFORTS)[number];

export type CodexAppConfig = {
  projectPath: string;
  newThread: boolean;
  threadId?: string;
  model: CodexAppModel;
  reasoningEffort: CodexAppReasoningEffort;
};

export type CodexAppInput = {
  prompt: string;
  attachments?: string[];
};

export type CodexAppRunRequest = {
  projectPath: string;
  threadId?: string;
  model: CodexAppModel;
  reasoningEffort: CodexAppReasoningEffort;
  prompt: string;
  attachments: string[];
  signal: AbortSignal;
};

export type CodexAppRunResult = {
  threadId: string;
};

export interface CodexAppController {
  deliver(request: CodexAppRunRequest): Promise<CodexAppRunResult>;
  shutdown?(): Promise<void>;
}
