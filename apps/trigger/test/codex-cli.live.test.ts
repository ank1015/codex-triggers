import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../src/domain/types.js";
import { createHarness, waitFor } from "./helpers/harness.js";

test(
  "live Codex CLI Delivery runs through the installed device authentication",
  { skip: process.env.TRIGGER_LIVE_CODEX_TEST !== "1" },
  async () => {
    const harness = await createHarness();
    const trigger = await harness.system.createTrigger({
      name: "Live Codex Delivery source",
      kind: "schedule",
      enabled: true,
      code: `
        export default function run() {
          return { message: "Reply with the word delivered", data: {} }
        }
      `,
      outputSchema: { type: "object", additionalProperties: false },
      timeoutMs: 2_000,
      schedule: {
        kind: "once",
        expression: new Date(Date.now() + 60_000).toISOString(),
        timezone: "UTC",
      },
    });
    const delivery = harness.system.delivery.create({
      name: "Live Codex CLI test",
      triggerId: trigger.details.trigger.id,
      enabled: true,
      services: [
        {
          type: "codex-cli",
          config: {
            projectPath: "",
            newThread: false,
            model: "luna",
            reasoningEffort: "low",
            sandboxMode: "read-only",
          },
          input: { prompt: "{{message}}. Do not use tools." },
        },
      ],
    });

    harness.system.runManually(
      trigger.details.trigger.id,
      {} as JsonValue,
    );
    await waitFor(() => {
      const job = harness.system.database.delivery.listJobs({
        deliveryId: delivery.delivery.id,
      })[0];
      assert.ok(job);
      assert.equal(job.status, "succeeded", job.error ?? undefined);
      assert.equal(job.result, null);
    }, 180_000);

    const threadId = harness.system.database.delivery.getDetails(
      delivery.delivery.id,
    )?.services[0]?.config.threadId;
    assert.equal(typeof threadId, "string");

    harness.system.runManually(
      trigger.details.trigger.id,
      {} as JsonValue,
    );
    await waitFor(() => {
      const jobs = harness.system.database.delivery.listJobs({
        deliveryId: delivery.delivery.id,
      });
      assert.equal(jobs.length, 2);
      assert.equal(
        jobs.every((job) => job.status === "succeeded" && job.result === null),
        true,
      );
    }, 180_000);
    assert.equal(
      harness.system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
        ?.config.threadId,
      threadId,
    );
  },
);
