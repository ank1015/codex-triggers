import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppDeliveryService,
  type CodexAppController,
  type CodexAppRunRequest,
} from "../src/delivery/services/codex-app/index.js";
import type { JsonValue } from "../src/domain/types.js";
import { createHarness, waitFor } from "./helpers/harness.js";

class FakeCodexAppController implements CodexAppController {
  readonly requests: CodexAppRunRequest[] = [];
  private nextThread = 1;

  async deliver(request: CodexAppRunRequest): Promise<{ threadId: string }> {
    this.requests.push(request);
    return { threadId: request.threadId ?? `app-thread-${this.nextThread++}` };
  }
}

async function createSourceTrigger(
  system: Awaited<ReturnType<typeof createHarness>>["system"],
) {
  return await system.createTrigger({
    name: "Codex App Delivery source",
    kind: "schedule",
    enabled: true,
    code: `
      export default function run() {
        return {
          message: "Review the change",
          data: {
            title: "Fix login",
            attachments: ["/tmp/change.patch", "/tmp/screenshot.png"],
          },
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["title", "attachments"],
      properties: {
        title: { type: "string" },
        attachments: { type: "array", items: { type: "string" } },
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

test("Codex App Delivery renders input and persists a reusable task", async () => {
  const controller = new FakeCodexAppController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);
  const delivery = harness.system.delivery.create({
    name: "Send changes to Codex App",
    triggerId: trigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "codex-app",
        config: {
          projectPath: process.cwd(),
          newThread: false,
          model: "terra",
          reasoningEffort: "high",
        },
        input: {
          prompt: "{{message}}: {{data.title}}",
          attachments: "{{data.attachments}}",
        },
      },
    ],
  });

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 1));

  assert.deepEqual(
    {
      ...controller.requests[0],
      signal: undefined,
    },
    {
      projectPath: process.cwd(),
      model: "terra",
      reasoningEffort: "high",
      prompt: "Review the change: Fix login",
      attachments: ["/tmp/change.patch", "/tmp/screenshot.png"],
      signal: undefined,
    },
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    "app-thread-1",
  );

  harness.system.runManually(trigger.details.trigger.id, {} as JsonValue);
  await waitFor(() => assert.equal(controller.requests.length, 2));
  assert.equal(controller.requests[1]?.threadId, "app-thread-1");
  assert.equal(
    harness.system.database.delivery
      .listJobs({ deliveryId: delivery.delivery.id })
      .every((job) => job.status === "succeeded" && job.result === null),
    true,
  );
});

test("Codex App Delivery creates a fresh task when newThread is true", async () => {
  const controller = new FakeCodexAppController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);
  const delivery = harness.system.delivery.create({
    name: "Fresh Codex App task",
    triggerId: trigger.details.trigger.id,
    enabled: true,
    services: [
      {
        type: "codex-app",
        config: {
          projectPath: "",
          newThread: true,
          threadId: "ignored-task",
          model: "sol",
          reasoningEffort: "xhigh",
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
    controller.requests.map(({ threadId, projectPath }) => ({
      threadId,
      projectPath,
    })),
    [
      { threadId: undefined, projectPath: "" },
      { threadId: undefined, projectPath: "" },
    ],
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    "ignored-task",
  );
});

test("Codex App Delivery rejects unsupported reasoning", async () => {
  const controller = new FakeCodexAppController();
  const harness = await createHarness({
    deliveryServices: [new CodexAppDeliveryService(controller)],
  });
  const trigger = await createSourceTrigger(harness.system);
  assert.throws(
    () =>
      harness.system.delivery.create({
        name: "Invalid Codex App reasoning",
        triggerId: trigger.details.trigger.id,
        enabled: true,
        services: [
          {
            type: "codex-app",
            config: {
              projectPath: "",
              newThread: true,
              model: "luna",
              reasoningEffort: "ultra",
            },
            input: { prompt: "{{message}}" },
          },
        ],
      }),
    /Invalid configuration for Delivery Service codex-app/,
  );
  assert.equal(controller.requests.length, 0);
});
