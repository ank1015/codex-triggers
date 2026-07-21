export type DesktopStatus = {
  status: "running";
  controlOrigin: string;
  webhookOrigin: string;
  dataDir: string;
  deliveryServices: string[];
};

export type TriggerSummary = {
  id: string;
  name: string;
  kind: "webhook" | "schedule" | "service";
  enabled: boolean;
};

export type TriggerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";

export type DeliveryRunStatus = "queued" | "running" | "succeeded" | "failed";
export type CodexModel = "luna" | "terra" | "sol";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type TriggerPageData = {
  trigger: TriggerSummary & {
    createdAt: string;
    updatedAt: string;
  };
  event: {
    code: string;
    timeoutMs: number;
    schedule: {
      kind: "cron" | "once";
      expression: string;
      timezone: string;
      nextRunAt: string | null;
    } | null;
    service: {
      status: "stopped" | "starting" | "running" | "failed";
      restartCount: number;
      lastError: string | null;
    } | null;
  };
  codex: {
    deliveryId: string;
    targetId: string;
    enabled: boolean;
    prompt: string;
    projectPath: string;
    newThread: boolean;
    threadId: string | null;
    model: CodexModel;
    reasoningEffort: CodexReasoningEffort;
    showInCodex: boolean;
  } | null;
  recentRuns: Array<{
    id: string;
    status: TriggerRunStatus;
    message: string | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
    deliveryStatus: DeliveryRunStatus | null;
    deliveryError: string | null;
    threadId: string | null;
  }>;
};

export type WebhookTunnelSettings = {
  enabled: boolean;
  publicWebhookUrl: string | null;
  error: string | null;
};

export type OnboardingStatus = {
  completed: boolean;
};

export type OnboardingResult =
  | {
      completed: true;
      skill: "installed" | "updated" | "current";
    }
  | {
      completed: false;
      error: string;
    };

export type DesktopApi = {
  getOnboardingStatus(): Promise<OnboardingStatus>;
  completeOnboarding(): Promise<OnboardingResult>;
  getStatus(): Promise<DesktopStatus>;
  listTriggers(): Promise<TriggerSummary[]>;
  getTriggerPage(triggerId: string): Promise<TriggerPageData | null>;
  setTriggerEnabled(triggerId: string, enabled: boolean): Promise<TriggerPageData>;
  setCodexShowInCodex(
    triggerId: string,
    showInCodex: boolean,
  ): Promise<TriggerPageData>;
  setCodexOptions(
    triggerId: string,
    options: {
      model?: CodexModel;
      reasoningEffort?: CodexReasoningEffort;
    },
  ): Promise<TriggerPageData>;
  deleteTrigger(triggerId: string): Promise<void>;
  openCodexNewChat(): Promise<void>;
  openCodexThread(threadId: string): Promise<void>;
  getWebhookTunnelSettings(): Promise<WebhookTunnelSettings>;
  setWebhookTunnelEnabled(enabled: boolean): Promise<WebhookTunnelSettings>;
};
