import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../src/domain/types.js";
import { createHarness, waitFor } from "./helpers/harness.js";

test("invalid output fails the execution and creates no notification", async () => {
  const { system } = await createHarness();
  const created = await system.createTrigger({
    name: "Schema failure",
    kind: "schedule",
    enabled: true,
    code: `
      export default async function run() {
        return { message: "bad", data: { count: "not-a-number" } }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["count"],
      properties: { count: { type: "number" } },
    },
    timeoutMs: 2_000,
    schedule: {
      kind: "once",
      expression: new Date(Date.now() + 60_000).toISOString(),
      timezone: "UTC",
    },
  });
  const execution = system.runManually(created.details.trigger.id, {} as JsonValue)!;
  await waitFor(() => {
    assert.equal(system.database.getExecution(execution.id)?.status, "failed");
  });
  assert.equal(
    system.database.listNotifications({ triggerId: created.details.trigger.id }).length,
    0,
  );
  assert.match(
    system.database.getExecution(execution.id)?.error ?? "",
    /did not match its schema/,
  );
});

test("code updates create immutable revisions and support rollback", async () => {
  const { system } = await createHarness();
  const outputSchema = {
    type: "object",
    required: ["version"],
    properties: { version: { type: "number" } },
  };
  const created = await system.createTrigger({
    name: "Revision test",
    kind: "webhook",
    enabled: true,
    code: `export default () => ({ message: "v1", data: { version: 1 } })`,
    outputSchema,
    timeoutMs: 2_000,
  });
  const triggerId = created.details.trigger.id;
  const firstRevision = created.details.revision.id;
  const updated = await system.updateTrigger(triggerId, {
    code: `export default () => ({ message: "v2", data: { version: 2 } })`,
  });
  assert.equal(updated?.revision.version, 2);
  assert.notEqual(updated?.revision.id, firstRevision);
  assert.equal(system.database.getRevision(firstRevision)?.version, 1);

  const execution = system.runManually(triggerId, {})!;
  await waitFor(() => {
    assert.equal(system.database.getExecution(execution.id)?.status, "succeeded");
  });
  assert.deepEqual(system.database.listNotifications({ triggerId })[0]?.output, {
    message: "v2",
    data: { version: 2 },
  });

  const rolledBack = await system.activateRevision(triggerId, firstRevision);
  assert.equal(rolledBack?.revision.version, 1);
  const rollbackExecution = system.runManually(triggerId, {})!;
  await waitFor(() => {
    assert.equal(
      system.database.getExecution(rollbackExecution.id)?.status,
      "succeeded",
    );
  });
  assert.deepEqual(system.database.listNotifications({ triggerId })[0]?.output, {
    message: "v1",
    data: { version: 1 },
  });
});

test("Trigger secrets are injected without being exposed by read APIs", async () => {
  const { system } = await createHarness();
  const secretValue = `secret-${crypto.randomUUID()}`;
  const created = await system.createTrigger({
    name: "Secret test",
    kind: "schedule",
    enabled: true,
    code: `
      export default async function run(_event, ctx) {
        return {
          message: "secret-read",
          data: { value: ctx.secrets.get("API_TOKEN") },
        }
      }
    `,
    outputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    timeoutMs: 2_000,
    schedule: {
      kind: "once",
      expression: new Date(Date.now() + 60_000).toISOString(),
      timezone: "UTC",
    },
  });
  const triggerId = created.details.trigger.id;
  await system.setSecret(triggerId, "API_TOKEN", secretValue);
  assert.deepEqual(system.database.listSecretNames(triggerId), ["API_TOKEN"]);
  assert.equal(
    JSON.stringify(system.database.getDetails(triggerId)).includes(secretValue),
    false,
  );

  const execution = system.runManually(triggerId, {})!;
  await waitFor(() => {
    assert.equal(system.database.getExecution(execution.id)?.status, "succeeded");
  });
  assert.deepEqual(system.database.listNotifications({ triggerId })[0]?.output, {
    message: "secret-read",
    data: { value: secretValue },
  });
});
