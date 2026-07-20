import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WEBHOOK_FUNNEL_PATH = "/codex-triggers";

export type WebhookTunnelStatus = {
  enabled: boolean;
  publicWebhookUrl: string | null;
  error: string | null;
};

export interface WebhookTunnel {
  status(): Promise<WebhookTunnelStatus>;
  setEnabled(enabled: boolean): Promise<WebhookTunnelStatus>;
}

type FunnelStatus = {
  Web?: Record<
    string,
    {
      Handlers?: Record<string, { Proxy?: string }>;
    }
  >;
};

export type TailscaleWebhookTunnelOptions = {
  port: number;
  executable?: string;
  runCommand?: (args: string[], timeoutMs: number) => Promise<string>;
};

function commandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: string };
  return details.stderr?.trim() || error.message;
}

function friendlyTailscaleError(error: unknown): string {
  const message = commandError(error).replace(/\s+/g, " ").trim();
  if (/tailscale is stopped/i.test(message)) {
    return "Tailscale is stopped. Start Tailscale and try again.";
  }
  if (/\bENOENT\b|not found/i.test(message)) {
    return "Tailscale is not installed or its CLI is unavailable.";
  }
  return message || "Tailscale could not update the webhook tunnel.";
}

export class TailscaleWebhookTunnel implements WebhookTunnel {
  private readonly executable: string;
  private readonly runCommand: (
    args: string[],
    timeoutMs: number,
  ) => Promise<string>;

  constructor(private readonly options: TailscaleWebhookTunnelOptions) {
    this.executable = options.executable ?? "tailscale";
    this.runCommand =
      options.runCommand ??
      (async (args, timeoutMs) => {
        const { stdout } = await execFileAsync(this.executable, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
        });
        return stdout;
      });
  }

  async status(): Promise<WebhookTunnelStatus> {
    try {
      await this.runCommand(["status", "--json"], 15_000);
      const stdout = await this.runCommand(
        ["funnel", "status", "--json"],
        15_000,
      );
      return this.parseStatus(JSON.parse(stdout) as FunnelStatus);
    } catch (error) {
      return {
        enabled: false,
        publicWebhookUrl: null,
        error: friendlyTailscaleError(error),
      };
    }
  }

  async setEnabled(enabled: boolean): Promise<WebhookTunnelStatus> {
    const args = [
      "funnel",
      "--bg",
      "--yes",
      `--set-path=${WEBHOOK_FUNNEL_PATH}`,
    ];
    args.push(enabled ? String(this.options.port) : "off");

    try {
      await this.runCommand(args, 30_000);
    } catch (error) {
      const status = await this.status();
      return {
        ...status,
        error: friendlyTailscaleError(error),
      };
    }

    const status = await this.status();
    if (status.error) return status;
    if (status.enabled !== enabled) {
      return {
        ...status,
        error: `Tailscale Funnel did not ${
          enabled ? "start" : "stop"
        } for the webhook listener.`,
      };
    }
    return status;
  }

  private parseStatus(status: FunnelStatus): WebhookTunnelStatus {
    for (const [authority, web] of Object.entries(status.Web ?? {})) {
      const proxy = web.Handlers?.[WEBHOOK_FUNNEL_PATH]?.Proxy;
      if (!proxy || !this.targetsWebhookPort(proxy)) continue;
      const host = authority.endsWith(":443") ? authority.slice(0, -4) : authority;
      return {
        enabled: true,
        publicWebhookUrl: `https://${host}${WEBHOOK_FUNNEL_PATH}`,
        error: null,
      };
    }
    return { enabled: false, publicWebhookUrl: null, error: null };
  }

  private targetsWebhookPort(proxy: string): boolean {
    try {
      return new URL(proxy).port === String(this.options.port);
    } catch {
      return false;
    }
  }
}
