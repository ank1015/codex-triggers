import assert from "node:assert/strict";
import { test } from "node:test";

import { createHarness, waitFor } from "./helpers/harness.js";

test("one-time Scheduled Trigger is durably dispatched exactly once", async () => {
  const { system } = await createHarness();
  const scheduledFor = new Date(Date.now() + 80).toISOString();
  const created = await system.createTrigger({
    name: "Scheduled test",
    kind: "schedule",
    enabled: true,
    code: `
      export default async function run(event, ctx) {
        await ctx.notify({
          message: "scheduled",
          data: { scheduledFor: event.scheduledFor },
        })
      }
    `,
    outputSchema: {
      type: "object",
      required: ["scheduledFor"],
      additionalProperties: false,
      properties: { scheduledFor: { type: "string" } },
    },
    timeoutMs: 2_000,
    schedule: { kind: "once", expression: scheduledFor, timezone: "UTC" },
  });

  await waitFor(() => {
    assert.equal(
      system.database.listNotifications({
        triggerId: created.details.trigger.id,
      }).length,
      1,
    );
  });
  await system.scheduler.tick(new Date(Date.now() + 10_000));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    system.database.listNotifications({
      triggerId: created.details.trigger.id,
    }).length,
    1,
  );
  assert.equal(
    system.database.getScheduleByTrigger(created.details.trigger.id)?.nextRunAt,
    null,
  );
});

test("cron Scheduled Trigger calculates and dispatches recurring runs", async () => {
  const { system } = await createHarness();
  const created = await system.createTrigger({
    name: "Cron test",
    kind: "schedule",
    enabled: true,
    code: `
      export default async function run(event, ctx) {
        await ctx.notify({
          message: "cron-fired",
          data: { scheduledFor: event.scheduledFor },
        })
      }
    `,
    outputSchema: {
      type: "object",
      required: ["scheduledFor"],
      properties: { scheduledFor: { type: "string" } },
    },
    timeoutMs: 2_000,
    schedule: {
      kind: "cron",
      expression: "*/1 * * * * *",
      timezone: "UTC",
    },
  });
  const triggerId = created.details.trigger.id;
  await waitFor(() => {
    assert.ok(system.database.listNotifications({ triggerId }).length >= 1);
  }, 2_500);
  const schedule = system.database.getScheduleByTrigger(triggerId);
  assert.ok(schedule?.nextRunAt);
  assert.ok(new Date(schedule.nextRunAt).getTime() > Date.now() - 1_000);
  await system.updateTrigger(triggerId, { enabled: false });
});
