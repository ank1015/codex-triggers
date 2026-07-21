import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  createHarness,
  restartHarness,
  waitFor,
} from "./helpers/harness.js";

test("Service Trigger is supervised, stopped, and restored after host restart", async () => {
  const first = await createHarness();
  const created = await first.system.createTrigger({
    name: "Service test",
    kind: "service",
    enabled: true,
    code: `
      export default {
        async start(ctx) {
          await ctx.notify({ message: "service-started", data: { started: true } })
          await ctx.untilStopped()
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["started"],
      additionalProperties: false,
      properties: { started: { const: true } },
    },
    timeoutMs: 0,
  });
  const triggerId = created.details.trigger.id;
  await waitFor(() => {
    assert.equal(
      first.system.database.listNotifications({ triggerId }).length,
      1,
    );
    assert.equal(first.system.database.getServiceState(triggerId)?.status, "running");
  });

  const restarted = await restartHarness(first);
  await waitFor(() => {
    assert.equal(
      restarted.system.database.listNotifications({ triggerId }).length,
      2,
    );
    assert.equal(
      restarted.system.database.getServiceState(triggerId)?.status,
      "running",
    );
  });
  const stopped = await restarted.system.setServiceEnabled(triggerId, false);
  assert.equal(stopped?.serviceState?.status, "stopped");
  assert.equal(stopped?.trigger.enabled, false);
});

test("Service Trigger is not restarted by presentation-only settings", async () => {
  const { system } = await createHarness();
  const created = await system.createTrigger({
    name: "Stable service",
    kind: "service",
    enabled: true,
    code: `
      export default {
        async start(ctx) {
          await ctx.untilStopped()
        }
      }
    `,
    outputSchema: true,
    timeoutMs: 0,
  });
  const triggerId = created.details.trigger.id;
  await waitFor(() => {
    assert.equal(system.database.getServiceState(triggerId)?.status, "running");
  });
  const originalExecution = system.database
    .listExecutions({ triggerId })
    .find(({ status }) => status === "running");
  assert.ok(originalExecution);

  await system.updateTrigger(triggerId, {
    name: "Renamed stable service",
    macosNotificationsEnabled: false,
  });

  const runningExecutions = system.database
    .listExecutions({ triggerId })
    .filter(({ status }) => status === "running");
  assert.equal(runningExecutions.length, 1);
  assert.equal(runningExecutions[0]?.id, originalExecution.id);
  assert.equal(system.database.getTrigger(triggerId)?.name, "Renamed stable service");
  assert.equal(
    system.database.getTrigger(triggerId)?.macosNotificationsEnabled,
    false,
  );
});

test("Service Trigger can host its own listening server without creating a process", async () => {
  const { system } = await createHarness();
  const created = await system.createTrigger({
    name: "Listening service",
    kind: "service",
    enabled: true,
    code: `
      import { createServer } from "node:http"

      export default {
        async start(ctx) {
          const server = createServer((request, response) => {
            void ctx.notify({
              message: "request-received",
              data: { event: "request", path: request.url },
            })
            response.end("service-ok")
          })
          await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
          const address = server.address()
          await ctx.notify({
            message: "service-listening",
            data: { event: "listening", port: address.port },
          })
          await ctx.untilStopped()
          await new Promise((resolve) => server.close(resolve))
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["event"],
      properties: {
        event: { enum: ["listening", "request"] },
        port: { type: "number" },
        path: { type: "string" },
      },
    },
    timeoutMs: 0,
  });
  const triggerId = created.details.trigger.id;
  let port = 0;
  await waitFor(() => {
    const notification = system.database
      .listNotifications({ triggerId })
      .find((item) => item.output.message === "service-listening");
    assert.ok(notification);
    port = (notification.output.data as { port: number }).port;
    assert.ok(port > 0);
  });

  const response = await fetch(`http://127.0.0.1:${port}/hello`);
  assert.equal(await response.text(), "service-ok");
  await waitFor(() => {
    const notification = system.database
      .listNotifications({ triggerId })
      .find((item) => item.output.message === "request-received");
    assert.deepEqual(notification?.output.data, {
      event: "request",
      path: "/hello",
    });
  });
  await system.setServiceEnabled(triggerId, false);
});

test("crashed Service Trigger restarts with host-managed backoff", async () => {
  const { system, directory } = await createHarness();
  const marker = join(directory, "service-restarted");
  const created = await system.createTrigger({
    name: "Restarting service",
    kind: "service",
    enabled: true,
    code: `
      import { access, writeFile } from "node:fs/promises"

      export default {
        async start(ctx) {
          try {
            await access(${JSON.stringify(marker)})
          } catch {
            await writeFile(${JSON.stringify(marker)}, "created")
            throw new Error("fail-first-start")
          }
          await ctx.notify({ message: "restarted", data: { restarted: true } })
          await ctx.untilStopped()
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["restarted"],
      properties: { restarted: { const: true } },
    },
    timeoutMs: 0,
  });
  const triggerId = created.details.trigger.id;
  await waitFor(() => {
    assert.equal(
      system.database.listNotifications({ triggerId })[0]?.output.message,
      "restarted",
    );
    assert.equal(system.database.getServiceState(triggerId)?.restartCount, 1);
    assert.equal(system.database.getServiceState(triggerId)?.status, "running");
  }, 4_000);
  await system.setServiceEnabled(triggerId, false);
});
