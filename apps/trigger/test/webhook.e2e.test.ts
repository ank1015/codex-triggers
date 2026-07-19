import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness, serverOrigin, waitFor } from "./helpers/harness.js";

test("webhook Trigger runs end to end through separate network listeners", async () => {
  const harness = await createHarness({ network: true, adminToken: "admin-secret" });
  const controlOrigin = serverOrigin(harness.controlServer!);
  const publicOrigin = serverOrigin(harness.publicServer!);

  const unauthorized = await fetch(`${controlOrigin}/v1/triggers`);
  assert.equal(unauthorized.status, 401);

  const createResponse = await fetch(`${controlOrigin}/v1/triggers`, {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Webhook test",
      kind: "webhook",
      code: `
        export default async function run(request, ctx) {
          const body = await request.json()
          ctx.log.info("received", body.value)
          await ctx.notify({
            message: \`received:\${body.value}\`,
            data: { value: body.value },
          })
        }
      `,
      outputSchema: {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: { value: { type: "number" } },
      },
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as {
    details: { trigger: { id: string }; webhook: { id: string } };
    webhookToken: string;
  };

  assert.equal((await fetch(`${publicOrigin}/v1/triggers`)).status, 404);
  assert.equal(
    (
      await fetch(
        `${publicOrigin}/hooks/v1/${created.details.webhook.id}/wrong-token`,
        { method: "POST", body: "{}" },
      )
    ).status,
    404,
  );

  const accepted = await fetch(
    `${publicOrigin}/hooks/v1/${created.details.webhook.id}/${created.webhookToken}`,
    {
      method: "POST",
      headers: {
        authorization: "must-not-be-stored",
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: 42 }),
    },
  );
  assert.equal(accepted.status, 202);
  const { executionId } = (await accepted.json()) as { executionId: string };

  await waitFor(() => {
    assert.equal(
      harness.system.database.getExecution(executionId)?.status,
      "succeeded",
    );
  });

  assert.deepEqual(
    harness.system.database.listNotifications({
      triggerId: created.details.trigger.id,
    })[0]?.output,
    { message: "received:42", data: { value: 42 } },
  );
  const execution = harness.system.database.getExecution(executionId)!;
  assert.equal(JSON.stringify(execution.input).includes('"type":"webhook"'), true);
  assert.equal(JSON.stringify(execution.input).includes("must-not-be-stored"), false);
  assert.deepEqual(harness.system.database.listLogs(executionId)[0]?.values, [
    "received",
    "42",
  ]);
});

test("webhook gateway accepts up to 10 MB and rejects larger payloads", async () => {
  const harness = await createHarness({ network: true });
  const publicOrigin = serverOrigin(harness.publicServer!);
  assert.equal(harness.system.config.maxWebhookBytes, 10_000_000);

  const withinLimit = await fetch(`${publicOrigin}/hooks/v1/unknown/unknown`, {
    method: "POST",
    body: new Uint8Array(4_100_000),
  });
  assert.equal(withinLimit.status, 404);

  const overLimit = await fetch(`${publicOrigin}/hooks/v1/unknown/unknown`, {
    method: "POST",
    body: new Uint8Array(10_000_001),
  });
  assert.equal(overLimit.status, 413);
});
