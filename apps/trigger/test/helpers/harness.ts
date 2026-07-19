import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";

import { serve, type ServerType } from "@hono/node-server";

import { loadConfig } from "../../src/config/index.js";
import type { DeliveryService } from "../../src/delivery/domain/types.js";
import { createControlApp } from "../../src/http/control-app.js";
import { createPublicApp } from "../../src/http/public-app.js";
import type {
  WebhookTunnel,
  WebhookTunnelStatus,
} from "../../src/integrations/tailscale-webhook-tunnel.js";
import { TriggerSystem } from "../../src/orchestration/trigger-system.js";

export type TestHarness = {
  system: TriggerSystem;
  controlServer?: ServerType;
  publicServer?: ServerType;
  directory: string;
  deliveryServices: DeliveryService[];
  webhookTunnel: WebhookTunnel;
};

const harnesses: TestHarness[] = [];

async function closeServer(server: ServerType | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function disposeHarness(
  harness: TestHarness,
  removeDirectory: boolean,
): Promise<void> {
  await closeServer(harness.publicServer);
  await closeServer(harness.controlServer);
  await harness.system.stop();
  harness.system.close();
  if (removeDirectory) {
    await rm(harness.directory, { recursive: true, force: true });
  }
}

afterEach(async () => {
  const harness = harnesses.pop();
  if (harness) await disposeHarness(harness, true);
});

function buildSystem(
  directory: string,
  adminToken: string | null,
  deliveryServices: DeliveryService[],
  webhookTunnel: WebhookTunnel,
): TriggerSystem {
  return new TriggerSystem(
    loadConfig({
      dataDir: directory,
      controlPort: 0,
      publicPort: 0,
      schedulerIntervalMs: 20,
      queueIntervalMs: 10,
      serviceStopTimeoutMs: 500,
      jobConcurrency: 2,
      adminToken,
    }),
    { deliveryServices, webhookTunnel },
  );
}

function disabledWebhookTunnel(): WebhookTunnel {
  const status: WebhookTunnelStatus = {
    enabled: false,
    publicWebhookUrl: null,
    error: null,
  };
  return {
    async status() {
      return status;
    },
    async setEnabled() {
      return status;
    },
  };
}

export async function createHarness(
  options: {
    network?: boolean;
    adminToken?: string;
    deliveryServices?: DeliveryService[];
    webhookTunnel?: WebhookTunnel;
  } = {},
): Promise<TestHarness> {
  const directory = await mkdtemp(join(tmpdir(), "trigger-test-"));
  const deliveryServices = options.deliveryServices ?? [];
  const webhookTunnel = options.webhookTunnel ?? disabledWebhookTunnel();
  const harness: TestHarness = {
    system: buildSystem(
      directory,
      options.adminToken ?? null,
      deliveryServices,
      webhookTunnel,
    ),
    directory,
    deliveryServices,
    webhookTunnel,
  };
  await harness.system.start();
  harnesses.push(harness);

  if (options.network) {
    harness.controlServer = serve({
      fetch: createControlApp(harness.system).fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    harness.publicServer = serve({
      fetch: createPublicApp(harness.system).fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    await Promise.all([
      once(harness.controlServer, "listening"),
      once(harness.publicServer, "listening"),
    ]);
  }

  return harness;
}

export async function restartHarness(
  current: TestHarness,
): Promise<TestHarness> {
  const registered = harnesses.pop();
  if (registered !== current) throw new Error("Unexpected active test harness");
  await disposeHarness(current, false);

  const restarted: TestHarness = {
    system: buildSystem(
      current.directory,
      null,
      current.deliveryServices,
      current.webhookTunnel,
    ),
    directory: current.directory,
    deliveryServices: current.deliveryServices,
    webhookTunnel: current.webhookTunnel,
  };
  harnesses.push(restarted);
  await restarted.system.start();
  return restarted;
}

export function serverOrigin(server: ServerType): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

export async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error("Condition was not met");
}
