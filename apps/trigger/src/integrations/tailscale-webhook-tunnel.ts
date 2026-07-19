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
};

function commandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: string };
  return details.stderr?.trim() || error.message;
}

export class TailscaleWebhookTunnel implements WebhookTunnel {
  private readonly executable: string;

  constructor(private readonly options: TailscaleWebhookTunnelOptions) {
    this.executable = options.executable ?? "tailscale";
  }

  async status(): Promise<WebhookTunnelStatus> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        ["funnel", "status", "--json"],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 1_000_000 },
      );
      return this.parseStatus(JSON.parse(stdout) as FunnelStatus);
    } catch (error) {
      return {
        enabled: false,
        publicWebhookUrl: null,
        error: commandError(error),
      };
    }
  }

  async setEnabled(enabled: boolean): Promise<WebhookTunnelStatus> {
    const args = [
      "funnel",
      "--bg",
      "--yes",
      `--set-path=${WEBHOOK_FUNNEL_PATH}`,
      String(this.options.port),
    ];
    if (!enabled) args.push("off");

    try {
      await execFileAsync(this.executable, args, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1_000_000,
      });
    } catch (error) {
      throw new Error(`Tailscale Funnel could not be updated: ${commandError(error)}`);
    }

    const status = await this.status();
    if (status.error) {
      throw new Error(`Tailscale Funnel status could not be read: ${status.error}`);
    }
    if (status.enabled !== enabled) {
      throw new Error(
        `Tailscale Funnel did not ${enabled ? "start" : "stop"} for the webhook listener`,
      );
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
