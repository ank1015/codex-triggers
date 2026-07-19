import assert from "node:assert/strict";
import { test } from "node:test";

import type { Input, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";

import type { JsonValue } from "../src/domain/types.js";
import {
  CodexCliDeliveryService,
  type CodexClientFactory,
  type ReasoningEffort,
} from "../src/delivery/services/codex-cli-service.js";
import { createHarness, waitFor } from "./helpers/harness.js";

type RunRecord = {
  kind: "start" | "resume";
  threadId: string;
  reasoningEffort: ReasoningEffort;
  options: ThreadOptions | undefined;
  input: Input;
};

function fakeCodexFactory(records: RunRecord[]): CodexClientFactory {
  let nextThread = 1;

  return (reasoningEffort) => ({
    startThread(options) {
      let id: string | null = null;
      return {
        get id() {
          return id;
        },
        async runStreamed(input) {
          id = `thread-${nextThread++}`;
          records.push({
            kind: "start",
            threadId: id,
            reasoningEffort,
            options,
            input,
          });
          return { events: completedEvents(id) };
        },
      };
    },
    resumeThread(threadId, options) {
      return {
        get id() {
          return threadId;
        },
        async runStreamed(input) {
          records.push({
            kind: "resume",
            threadId,
            reasoningEffort,
            options,
            input,
          });
          return { events: completedEvents(threadId) };
        },
      };
    },
  });
}

async function* completedEvents(threadId: string): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: threadId };
  yield { type: "turn.started" };
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
}

async function createSourceTrigger(
  system: Awaited<ReturnType<typeof createHarness>>["system"],
) {
  return await system.createTrigger({
    name: "Codex Delivery source",
    kind: "schedule",
    enabled: true,
    code: `
      export default function run() {
        return {
          message: "Review the change",
          data: { title: "Fix login", images: ["/tmp/example.png"] },
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

test("Codex CLI Delivery creates and persists a reusable thread", async () => {
  const records: RunRecord[] = [];
  const harness = await createHarness({
    deliveryServices: [
      new CodexCliDeliveryService(
        process.cwd(),
        fakeCodexFactory(records),
      ),
    ],
  });
  const trigger = await createSourceTrigger(harness.system);
  const triggerId = trigger.details.trigger.id;
  const delivery = harness.system.delivery.create({
    name: "Send changes to Codex",
    triggerId,
    enabled: true,
    services: [
      {
        type: "codex-cli",
        config: {
          projectPath: "",
          newThread: false,
          model: "luna",
          reasoningEffort: "high",
          networkAccessEnabled: true,
        },
        input: {
          prompt: "{{message}}: {{data.title}}",
          images: "{{data.images}}",
        },
      },
    ],
  });
  const targetId = delivery.services[0]!.id;

  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => {
    assert.equal(records.length, 1);
    assert.equal(
      harness.system.database.delivery.listJobs({
        deliveryId: delivery.delivery.id,
      })[0]?.status,
      "succeeded",
    );
  });

  assert.deepEqual(records[0], {
    kind: "start",
    threadId: "thread-1",
    reasoningEffort: "high",
    options: {
      model: "gpt-5.6-luna",
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
    },
    input: [
      { type: "text", text: "Review the change: Fix login" },
      { type: "local_image", path: "/tmp/example.png" },
    ],
  });
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    "thread-1",
  );
  assert.equal(
    harness.system.database.delivery.listJobs({
      deliveryId: delivery.delivery.id,
    })[0]?.result,
    null,
  );

  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => assert.equal(records.length, 2));
  assert.equal(records[1]?.kind, "resume");
  assert.equal(records[1]?.threadId, "thread-1");
  assert.equal(
    harness.system.database.delivery
      .listJobs({ deliveryId: delivery.delivery.id })
      .every((job) => job.status === "succeeded" && job.result === null),
    true,
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.id,
    targetId,
  );
});

test("Codex CLI Delivery starts a fresh thread for every newThread job", async () => {
  const records: RunRecord[] = [];
  const harness = await createHarness({
    deliveryServices: [
      new CodexCliDeliveryService(
        process.cwd(),
        fakeCodexFactory(records),
      ),
    ],
  });
  const trigger = await createSourceTrigger(harness.system);
  const triggerId = trigger.details.trigger.id;
  const delivery = harness.system.delivery.create({
    name: "Fresh Codex thread",
    triggerId,
    enabled: true,
    services: [
      {
        type: "codex-cli",
        config: {
          projectPath: "",
          newThread: true,
          threadId: "must-be-ignored",
          model: "sol",
          reasoningEffort: "low",
          sandboxMode: "read-only",
        },
        input: { prompt: "{{message}}" },
      },
    ],
  });

  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => assert.equal(records.length, 1));
  harness.system.runManually(triggerId, {} as JsonValue);
  await waitFor(() => assert.equal(records.length, 2));

  assert.deepEqual(
    records.map(({ kind, threadId }) => ({ kind, threadId })),
    [
      { kind: "start", threadId: "thread-1" },
      { kind: "start", threadId: "thread-2" },
    ],
  );
  assert.equal(
    harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
      ?.config.threadId,
    "must-be-ignored",
  );
});
