import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WebhookTunnel,
  WebhookTunnelStatus,
} from "../src/integrations/tailscale-webhook-tunnel.js";
import { createHarness, serverOrigin } from "./helpers/harness.js";

class FakeWebhookTunnel implements WebhookTunnel {
  enabled = false;

  async status(): Promise<WebhookTunnelStatus> {
    return {
      enabled: this.enabled,
      publicWebhookUrl: this.enabled
        ? "https://device.example.ts.net/codex-triggers"
        : null,
      error: null,
    };
  }

  async setEnabled(enabled: boolean): Promise<WebhookTunnelStatus> {
    this.enabled = enabled;
    return await this.status();
  }
}

test("webhook tunnel settings expose and apply the public webhook URL", async () => {
  const tunnel = new FakeWebhookTunnel();
  const harness = await createHarness({ network: true, webhookTunnel: tunnel });
  const controlOrigin = serverOrigin(harness.controlServer!);

  const initial = await fetch(`${controlOrigin}/v1/settings/webhook-tunnel`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    enabled: false,
    publicWebhookUrl: null,
    error: null,
  });

  const enabled = await fetch(`${controlOrigin}/v1/settings/webhook-tunnel`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), {
    enabled: true,
    publicWebhookUrl: "https://device.example.ts.net/codex-triggers",
    error: null,
  });

  const publicUrl = await fetch(`${controlOrigin}/v1/public-webhook-url`);
  assert.deepEqual(await publicUrl.json(), {
    publicWebhookUrl: "https://device.example.ts.net/codex-triggers",
    error: null,
  });

  const created = await fetch(`${controlOrigin}/v1/triggers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Public webhook",
      kind: "webhook",
      code: "export default () => ({ message: 'ok', data: {} })",
      outputSchema: { type: "object", additionalProperties: false },
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { webhookUrl: string };
  assert.match(
    createdBody.webhookUrl,
    /^https:\/\/device\.example\.ts\.net\/codex-triggers\/hooks\/v1\//,
  );

  const disabled = await fetch(`${controlOrigin}/v1/settings/webhook-tunnel`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(tunnel.enabled, false);
  assert.deepEqual(await disabled.json(), {
    enabled: false,
    publicWebhookUrl: null,
    error: null,
  });

  const unavailableUrl = await fetch(`${controlOrigin}/v1/public-webhook-url`);
  assert.deepEqual(await unavailableUrl.json(), {
    publicWebhookUrl: null,
    error: "Tailscale webhook tunnel has not been started",
  });
});
