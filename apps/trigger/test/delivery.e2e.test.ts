import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../src/domain/types.js";
import type {
  DeliveryService,
  DeliveryServiceRequest,
} from "../src/delivery/domain/types.js";
import { createHarness, serverOrigin, waitFor } from "./helpers/harness.js";

function captureService(received: DeliveryServiceRequest[]): DeliveryService {
  return {
    type: "capture",
    configSchema: {
      type: "object",
      required: ["projectId"],
      additionalProperties: false,
      properties: { projectId: { type: "string" } },
    },
    inputSchema: {
      type: "object",
      required: ["prompt", "attachments", "metadata"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string" },
        attachments: { type: "array" },
        metadata: {
          type: "object",
          required: ["number"],
          properties: { number: { type: "number" } },
        },
      },
    },
    async deliver(request) {
      received.push(request);
      return { accepted: true, projectId: String(request.config.projectId) };
    },
  };
}

async function createTestTrigger(
  system: Awaited<ReturnType<typeof createHarness>>["system"],
) {
  return await system.createTrigger({
    name: "Delivery source",
    kind: "schedule",
    enabled: true,
    code: `
      export default function run() {
        return {
          message: "Pull request opened",
          data: {
            title: "Fix login",
            number: 42,
            attachments: [{ type: "url", url: "https://example.com/pr/42" }],
          },
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["title", "number", "attachments"],
      properties: {
        title: { type: "string" },
        number: { type: "number" },
        attachments: { type: "array" },
      },
    },
    timeoutMs: 2_000,
    schedule: {
      kind: "once",
      expression: new Date(Date.now() + 60_000).toISOString(),
      timezone: "UTC",
    },
  });
}

test("Delivery APIs expose registered services and reject unknown ones", async () => {
  const harness = await createHarness({ network: true });
  const controlOrigin = serverOrigin(harness.controlServer!);
  const servicesResponse = await fetch(`${controlOrigin}/v1/delivery-services`);
  assert.equal(servicesResponse.status, 200);
  const discovered = (await servicesResponse.json()) as {
    services: Array<{ type: string }>;
  };
  assert.deepEqual(
    discovered.services.map((service) => service.type),
    ["codex-cli", "codex-app", "codex-app-server"],
  );

  const trigger = await createTestTrigger(harness.system);
  const response = await fetch(`${controlOrigin}/v1/deliveries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Unknown destination",
      triggerId: trigger.details.trigger.id,
      services: [{ type: "missing", config: {}, input: {} }],
    }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /Unknown Delivery Service/);
});

test("Notification data is rendered and delivered through a configured service", async () => {
  const received: DeliveryServiceRequest[] = [];
  const harness = await createHarness({
    network: true,
    deliveryServices: [captureService(received)],
  });
  const controlOrigin = serverOrigin(harness.controlServer!);
  const trigger = await createTestTrigger(harness.system);

  const createResponse = await fetch(`${controlOrigin}/v1/deliveries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Review new pull requests",
      triggerId: trigger.details.trigger.id,
      services: [
        {
          type: "capture",
          config: { projectId: "project-123" },
          input: {
            prompt: "Review {{data.title}} (#{{data.number}}): {{message}}",
            attachments: "{{data.attachments}}",
            metadata: { number: "{{data.number}}" },
          },
        },
      ],
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as {
    details: { delivery: { id: string } };
  };

  const execution = harness.system.runManually(
    trigger.details.trigger.id,
    {} as JsonValue,
  )!;
  await waitFor(() => {
    assert.equal(harness.system.database.getExecution(execution.id)?.status, "succeeded");
    assert.equal(received.length, 1);
  });

  assert.deepEqual(received[0]?.config, { projectId: "project-123" });
  assert.deepEqual(received[0]?.input, {
    prompt: "Review Fix login (#42): Pull request opened",
    attachments: [{ type: "url", url: "https://example.com/pr/42" }],
    metadata: { number: 42 },
  });

  const jobsResponse = await fetch(
    `${controlOrigin}/v1/delivery-jobs?deliveryId=${created.details.delivery.id}`,
  );
  const { jobs } = (await jobsResponse.json()) as {
    jobs: Array<{ id: string; status: string; result: JsonValue }>;
  };
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "succeeded");
  assert.deepEqual(jobs[0]?.result, {
    accepted: true,
    projectId: "project-123",
  });

  const deleted = await fetch(
    `${controlOrigin}/v1/deliveries/${created.details.delivery.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 204);
  assert.ok(harness.system.database.delivery.getJob(jobs[0]!.id));
});

test("running Delivery jobs keep their original settings when the Delivery changes", async () => {
  const received: DeliveryServiceRequest[] = [];
  let signalStarted!: () => void;
  let releaseDelivery!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const blockingService = captureService(received);
  blockingService.deliver = async (request) => {
    received.push(request);
    signalStarted();
    await released;
    return { accepted: true, projectId: String(request.config.projectId) };
  };

  const harness = await createHarness({
    deliveryServices: [blockingService],
  });
  const trigger = await createTestTrigger(harness.system);
  const delivery = harness.system.delivery.create({
    name: "Snapshot settings",
    triggerId: trigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "capture",
        config: { projectId: "original-project" },
        input: {
          prompt: "{{message}}",
          attachments: "{{data.attachments}}",
          metadata: { number: "{{data.number}}" },
        },
      },
    ],
  });

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await started;
  assert.deepEqual(received[0]?.config, { projectId: "original-project" });

  harness.system.delivery.update(delivery.delivery.id, {
    services: [
      {
        type: "capture",
        config: { projectId: "updated-project" },
        input: {
          prompt: "Updated: {{message}}",
          attachments: "{{data.attachments}}",
          metadata: { number: "{{data.number}}" },
        },
      },
    ],
  });
  assert.deepEqual(received[0]?.config, { projectId: "original-project" });
  assert.equal(received[0]?.input.prompt, "Pull request opened");

  releaseDelivery();
  await waitFor(() => {
    const jobs = harness.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
    });
    assert.equal(jobs[0]?.status, "succeeded");
  });
  assert.deepEqual(received[0]?.config, { projectId: "original-project" });
});

test("configured service jobs fail independently", async () => {
  const received: DeliveryServiceRequest[] = [];
  const harness = await createHarness({
    deliveryServices: [captureService(received)],
  });
  const trigger = await createTestTrigger(harness.system);
  const triggerId = trigger.details.trigger.id;
  const validInput = {
    prompt: "Review {{data.title}}",
    attachments: "{{data.attachments}}",
    metadata: { number: "{{data.number}}" },
  } as const;
  const delivery = harness.system.delivery.create({
    name: "Independent jobs",
    triggerId,
    enabled: true,
    services: [
      {
        type: "capture",
        config: { projectId: "valid" },
        input: validInput,
      },
      {
        type: "capture",
        config: { projectId: "invalid" },
        input: {
          ...validInput,
          prompt: "Review {{data.missing}}",
        },
      },
    ],
  });

  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => {
    const jobs = harness.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
    });
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((job) => job.status).sort(),
      ["failed", "succeeded"],
    );
  });
  assert.equal(received.length, 1);
  const failed = harness.system.database.delivery
    .listJobs({ deliveryId: delivery.delivery.id })
    .find((job) => job.status === "failed");
  assert.match(failed?.error ?? "", /data\.missing does not exist/);
});

test("disabled Deliveries only receive Notifications created after enabling", async () => {
  const received: DeliveryServiceRequest[] = [];
  const harness = await createHarness({
    deliveryServices: [captureService(received)],
  });
  const trigger = await createTestTrigger(harness.system);
  const triggerId = trigger.details.trigger.id;
  const delivery = harness.system.delivery.create({
    name: "Initially disabled",
    triggerId,
    enabled: false,
    services: [
      {
        type: "capture",
        config: { projectId: "project" },
        input: {
          prompt: "{{message}}",
          attachments: "{{data.attachments}}",
          metadata: { number: "{{data.number}}" },
        },
      },
    ],
  });

  const first = harness.system.runManually(triggerId, {} as JsonValue)!;
  await waitFor(() => {
    assert.equal(harness.system.database.getExecution(first.id)?.status, "succeeded");
  });
  assert.equal(
    harness.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
    }).length,
    0,
  );

  harness.system.delivery.update(delivery.delivery.id, { enabled: true });
  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => assert.equal(received.length, 1));
  assert.equal(
    harness.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
    }).length,
    1,
  );
});
