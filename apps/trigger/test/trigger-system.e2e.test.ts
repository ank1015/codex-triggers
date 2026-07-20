import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import type {
  DeliveryService,
  DeliveryServiceRequest,
} from "../src/delivery/domain/types.js";
import { createHarness, serverOrigin, waitFor } from "./helpers/harness.js";

function captureService(received: DeliveryServiceRequest[]): DeliveryService {
  return {
    type: "capture-system",
    configSchema: {
      type: "object",
      required: ["destination"],
      additionalProperties: false,
      properties: { destination: { type: "string" } },
    },
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: { prompt: { type: "string" } },
    },
    async deliver(request) {
      received.push(request);
      return null;
    },
  };
}

test("one API call creates and wires a Trigger with its Delivery", async () => {
  const received: DeliveryServiceRequest[] = [];
  const harness = await createHarness({
    network: true,
    deliveryServices: [captureService(received)],
  });
  const controlOrigin = serverOrigin(harness.controlServer!);

  const response = await fetch(`${controlOrigin}/v1/trigger-systems`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trigger: {
        name: "Combined webhook",
        kind: "webhook",
        code: `
          export default async function run(request) {
            const body = await request.json()
            return {
              message: "Received " + body.title,
              data: { title: body.title },
            }
          }
        `,
        outputSchema: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string" } },
        },
      },
      delivery: {
        name: "Send combined webhook",
        services: [
          {
            type: "capture-system",
            config: { destination: "test" },
            input: { prompt: "{{message}}: {{data.title}}" },
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 201);
  const created = (await response.json()) as {
    trigger: {
      details: { trigger: { id: string; enabled: boolean } };
      webhookUrl: string;
      webhookToken: string;
    };
    delivery: {
      delivery: { id: string; triggerId: string; enabled: boolean };
    };
  };
  const triggerId = created.trigger.details.trigger.id;
  assert.equal(created.trigger.details.trigger.enabled, true);
  assert.equal(created.delivery.delivery.triggerId, triggerId);
  assert.equal(created.delivery.delivery.enabled, true);
  assert.ok(created.trigger.webhookUrl);
  assert.ok(created.trigger.webhookToken);

  const runResponse = await fetch(`${controlOrigin}/v1/triggers/${triggerId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Pull request" }),
  });
  assert.equal(runResponse.status, 202);
  await waitFor(() => assert.equal(received.length, 1));
  assert.deepEqual(received[0]?.input, {
    prompt: "Received Pull request: Pull request",
  });
});

test("invalid Delivery configuration creates no partial Trigger", async () => {
  const harness = await createHarness({
    network: true,
    deliveryServices: [captureService([])],
  });
  const controlOrigin = serverOrigin(harness.controlServer!);

  const response = await fetch(`${controlOrigin}/v1/trigger-systems`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trigger: {
        name: "Must roll back",
        kind: "schedule",
        schedule: {
          kind: "once",
          expression: new Date(Date.now() + 60_000).toISOString(),
          timezone: "UTC",
        },
        code: "export default () => ({ message: 'test', data: {} })",
      },
      delivery: {
        name: "Invalid destination",
        services: [
          {
            type: "capture-system",
            config: {},
            input: { prompt: "{{message}}" },
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(harness.system.database.listTriggers().length, 0);
  assert.equal(harness.system.database.delivery.listDeliveries().length, 0);
  await assert.rejects(
    access(harness.system.codeStore.revisionDir),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
