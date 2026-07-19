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

export type WebhookTunnelSettings = {
  enabled: boolean;
  publicWebhookUrl: string | null;
  error: string | null;
};

export type DesktopApi = {
  getStatus(): Promise<DesktopStatus>;
  listActiveTriggers(): Promise<ActiveTrigger[]>;
  openCodexNewChat(): Promise<void>;
  getWebhookTunnelSettings(): Promise<WebhookTunnelSettings>;
  setWebhookTunnelEnabled(enabled: boolean): Promise<WebhookTunnelSettings>;
};
