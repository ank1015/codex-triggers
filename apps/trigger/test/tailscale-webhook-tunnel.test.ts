import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TailscaleWebhookTunnel,
  WEBHOOK_FUNNEL_PATH,
} from "../src/integrations/tailscale-webhook-tunnel.js";

test("Tailscale webhook tunnel uses scoped start and stop commands", async () => {
  let enabled = false;
  const commands: string[][] = [];
  const tunnel = new TailscaleWebhookTunnel({
    port: 47_832,
    async runCommand(args) {
      commands.push(args);
      if (args[0] === "status") return "{}";
      if (args[0] === "funnel" && args[1] === "status") {
        return JSON.stringify(
          enabled
            ? {
                Web: {
                  "ank-macbook-pro.example.ts.net:443": {
                    Handlers: {
                      [WEBHOOK_FUNNEL_PATH]: {
                        Proxy: "http://127.0.0.1:47832",
                      },
                    },
                  },
                },
              }
            : {},
        );
      }
      enabled = args.at(-1) !== "off";
      return "";
    },
  });

  const started = await tunnel.setEnabled(true);
  assert.equal(started.enabled, true);
  assert.equal(started.error, null);
  assert.deepEqual(commands[0], [
    "funnel",
    "--bg",
    "--yes",
    "--set-path=/codex-triggers",
    "47832",
  ]);

  commands.length = 0;
  const stopped = await tunnel.setEnabled(false);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.error, null);
  assert.deepEqual(commands[0], [
    "funnel",
    "--bg",
    "--yes",
    "--set-path=/codex-triggers",
    "off",
  ]);
});

test("Tailscale operational failures are returned instead of thrown", async () => {
  const stoppedError = Object.assign(new Error("command failed"), {
    stderr: "Tailscale is stopped.\n",
  });
  const tunnel = new TailscaleWebhookTunnel({
    port: 47_832,
    async runCommand() {
      throw stoppedError;
    },
  });

  const status = await tunnel.setEnabled(true);
  assert.deepEqual(status, {
    enabled: false,
    publicWebhookUrl: null,
    error: "Tailscale is stopped. Start Tailscale and try again.",
  });
});
