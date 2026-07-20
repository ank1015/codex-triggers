import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerDeliveryService,
  type CodexAppServerController,
  type CodexAppServerRunRequest,
} from "../src/delivery/services/codex-app-server/index.js";
import type { JsonValue } from "../src/domain/types.js";
import { createHarness, waitFor } from "./helpers/harness.js";

class FakeCodexAppServerController implements CodexAppServerController {
  readonly requests: CodexAppServerRunRequest[] = [];
  private nextThread = 1;

  async deliver(request: CodexAppServerRunRequest): Promise<{ threadId: string }> {
    this.requests.push(request);
    return {
      threadId: request.threadId ?? `app-server-thread-${this.nextThread++}`,
    };
  }
}

async function createSourceTrigger(
  system: Awaited<ReturnType<typeof createHarness>>["system"],
) {
  return await system.createTrigger({
    name: "Codex app-server Delivery source",
    kind: "schedule",
    enabled: true,
    code: `
      export default function run() {
        return {
          message: "Review the change",
          data: {
            title: "Fix login",
            images: ["/tmp/change.png", "https://example.com/context.png"],
          },
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["title", "images"],
      properties: {
        title: { type: "string" },
        images: { type: "array", items: { type: "string" } },
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

test("Codex app-server Delivery persists and reuses a durable thread", async () => {
  const controller = new FakeCodexAppServerController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppServerDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);
  const delivery = harness.system.delivery.create({
    name: "Send changes through Codex app-server",
    triggerId: trigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "codex-app-server",
        config: {
          projectPath: process.cwd(),
          newThread: false,
          model: "terra",
          reasoningEffort: "high",
          threadMode: "persistent",
        },
        input: {
          prompt: "{{message}}: {{data.title}}",
          images: "{{data.images}}",
        },
      },
    ],
  });

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 1));
  assert.deepEqual(
    { ...controller.requests[0], signal: undefined },
    {
      projectPath: process.cwd(),
      model: "terra",
      reasoningEffort: "high",
      threadMode: "persistent",
      prompt: "Review the change: Fix login",
      images: ["/tmp/change.png", "https://example.com/context.png"],
      signal: undefined,
    },
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    "app-server-thread-1",
  );

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 2));
  assert.equal(controller.requests[1]?.threadId, "app-server-thread-1");
  assert.deepEqual(
    harness.system.database.delivery
      .listJobs({ deliveryId: delivery.delivery.id })
      .map((job) => ({ status: job.status, result: job.result })),
    [
      {
        status: "succeeded",
        result: { threadId: "app-server-thread-1" },
      },
      {
        status: "succeeded",
        result: { threadId: "app-server-thread-1" },
      },
    ],
  );
});

test("Codex app-server Delivery creates unsaved ephemeral threads", async () => {
  const controller = new FakeCodexAppServerController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppServerDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);
  const delivery = harness.system.delivery.create({
    name: "Ephemeral Codex app-server task",
    triggerId: trigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "codex-app-server",
        config: {
          projectPath: "",
          newThread: true,
          model: "luna",
          reasoningEffort: "low",
          threadMode: "ephemeral",
        },
        input: { prompt: "{{message}}" },
      },
    ],
  });

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 1));
  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 2));

  assert.deepEqual(
    controller.requests.map(({ threadId, threadMode }) => ({
      threadId,
      threadMode,
    })),
    [
      { threadId: undefined, threadMode: "ephemeral" },
      { threadId: undefined, threadMode: "ephemeral" },
    ],
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    undefined,
  );
});

test("Codex app-server Delivery rejects reusable ephemeral threads", async () => {
  const controller = new FakeCodexAppServerController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppServerDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);

  assert.throws(
    () =>
      harness.system.delivery.create({
        name: "Invalid reusable ephemeral task",
        triggerId: trigger.details.trigger.id,
        enabled: true,
        services: [
          {
            type: "codex-app-server",
            config: {
              projectPath: "",
              newThread: false,
              model: "sol",
              reasoningEffort: "xhigh",
              threadMode: "ephemeral",
            },
            input: { prompt: "{{message}}" },
          },
        ],
      }),
    /Invalid configuration for Delivery Service codex-app-server/,
  );
  assert.equal(controller.requests.length, 0);
});
