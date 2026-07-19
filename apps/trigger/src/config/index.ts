import { resolve } from "node:path";

export type TriggerConfig = {
  dataDir: string;
  controlHost: string;
  controlPort: number;
  publicHost: string;
  publicPort: number;
  publicBaseUrl: string | null;
  adminToken: string | null;
  maxWebhookBytes: number;
  jobConcurrency: number;
  schedulerIntervalMs: number;
  queueIntervalMs: number;
  serviceStopTimeoutMs: number;
  codexAppPath: string;
};

function integerEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function loadConfig(
  overrides: Partial<TriggerConfig> = {},
): TriggerConfig {
  const publicBaseUrl = process.env.TRIGGER_PUBLIC_URL?.trim() || null;
  const adminToken = process.env.TRIGGER_ADMIN_TOKEN?.trim() || null;

  return {
    dataDir: resolve(
      overrides.dataDir ?? process.env.TRIGGER_DATA_DIR ?? "data/trigger",
    ),
    controlHost:
      overrides.controlHost ?? process.env.TRIGGER_CONTROL_HOST ?? "127.0.0.1",
    controlPort:
      overrides.controlPort ?? integerEnv("TRIGGER_CONTROL_PORT", 47_831),
    publicHost:
      overrides.publicHost ?? process.env.TRIGGER_PUBLIC_HOST ?? "127.0.0.1",
    publicPort:
      overrides.publicPort ?? integerEnv("TRIGGER_PUBLIC_PORT", 47_832),
    publicBaseUrl: overrides.publicBaseUrl ?? publicBaseUrl,
    adminToken: overrides.adminToken ?? adminToken,
    maxWebhookBytes:
      overrides.maxWebhookBytes ??
      integerEnv("TRIGGER_MAX_WEBHOOK_BYTES", 10_000_000),
    jobConcurrency:
      overrides.jobConcurrency ?? integerEnv("TRIGGER_JOB_CONCURRENCY", 4),
    schedulerIntervalMs:
      overrides.schedulerIntervalMs ??
      integerEnv("TRIGGER_SCHEDULER_INTERVAL_MS", 500, 50),
    queueIntervalMs:
      overrides.queueIntervalMs ??
      integerEnv("TRIGGER_QUEUE_INTERVAL_MS", 100, 10),
    serviceStopTimeoutMs:
      overrides.serviceStopTimeoutMs ??
      integerEnv("TRIGGER_SERVICE_STOP_TIMEOUT_MS", 5_000, 100),
    codexAppPath:
      overrides.codexAppPath ??
      process.env.TRIGGER_CODEX_APP_PATH ??
      "/Applications/ChatGPT.app",
  };
}
