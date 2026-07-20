export type DesktopStatus = {
  status: "running";
  controlOrigin: string;
  webhookOrigin: string;
  dataDir: string;
  deliveryServices: string[];
};

export type ActiveTrigger = {
  id: string;
  name: string;
  kind: "webhook" | "schedule" | "service";
};

export type TriggerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";

export type DeliveryRunStatus = "queued" | "running" | "succeeded" | "failed";

export type TriggerPageData = {
  trigger: ActiveTrigger & {
    enabled: boolean;
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
    model: "luna" | "terra" | "sol";
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
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

export type DesktopApi = {
  getStatus(): Promise<DesktopStatus>;
  listActiveTriggers(): Promise<ActiveTrigger[]>;
  getTriggerPage(triggerId: string): Promise<TriggerPageData | null>;
  setTriggerEnabled(triggerId: string, enabled: boolean): Promise<TriggerPageData>;
  setCodexShowInCodex(
    triggerId: string,
    showInCodex: boolean,
  ): Promise<TriggerPageData>;
  openCodexNewChat(): Promise<void>;
  openCodexThread(threadId: string): Promise<void>;
  getWebhookTunnelSettings(): Promise<WebhookTunnelSettings>;
  setWebhookTunnelEnabled(enabled: boolean): Promise<WebhookTunnelSettings>;
};
