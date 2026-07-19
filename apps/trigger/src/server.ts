import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { serve, type ServerType } from "@hono/node-server";

import type { TriggerConfig } from "./config/index.js";
import { createControlApp } from "./http/control-app.js";
import { createPublicApp } from "./http/public-app.js";
import {
  TriggerSystem,
  type TriggerSystemOptions,
} from "./orchestration/trigger-system.js";

export type TriggerServerAddresses = {
  control: { host: string; port: number; origin: string };
  public: { host: string; port: number; origin: string };
};

async function waitUntilListening(server: ServerType): Promise<void> {
  if (server.listening) return;
  await Promise.race([
    once(server, "listening").then(() => undefined),
    once(server, "error").then(([error]) => Promise.reject(error)),
  ]);
}

async function closeServer(server: ServerType | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverAddress(server: ServerType, configuredHost: string): {
  host: string;
  port: number;
  origin: string;
} {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Trigger server does not have a TCP address");
  }
  const port = (address as AddressInfo).port;
  const host = configuredHost.includes(":")
    ? `[${configuredHost}]`
    : configuredHost;
  return { host: configuredHost, port, origin: `http://${host}:${port}` };
}

export class TriggerServer {
  readonly system: TriggerSystem;
  private controlServer: ServerType | null = null;
  private publicServer: ServerType | null = null;
  private started = false;
  private closed = false;

  constructor(
    readonly config: TriggerConfig,
    options: TriggerSystemOptions = {},
  ) {
    this.system = new TriggerSystem(config, options);
  }

  get addresses(): TriggerServerAddresses | null {
    if (!this.controlServer || !this.publicServer) return null;
    return {
      control: serverAddress(this.controlServer, this.config.controlHost),
      public: serverAddress(this.publicServer, this.config.publicHost),
    };
  }

  async start(): Promise<TriggerServerAddresses> {
    if (this.closed) throw new Error("Trigger server has been closed");
    if (this.started) return this.addresses!;

    await this.system.start();
    try {
      this.controlServer = serve({
        fetch: createControlApp(this.system).fetch,
        hostname: this.config.controlHost,
        port: this.config.controlPort,
      });
      await waitUntilListening(this.controlServer);

      this.publicServer = serve({
        fetch: createPublicApp(this.system).fetch,
        hostname: this.config.publicHost,
        port: this.config.publicPort,
      });
      await waitUntilListening(this.publicServer);
      this.started = true;
      return this.addresses!;
    } catch (error) {
      await Promise.allSettled([
        closeServer(this.publicServer),
        closeServer(this.controlServer),
      ]);
      this.publicServer = null;
      this.controlServer = null;
      await this.system.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      closeServer(this.publicServer),
      closeServer(this.controlServer),
    ]);
    this.publicServer = null;
    this.controlServer = null;
    await this.system.stop();
    this.system.close();
    this.started = false;
  }
}
