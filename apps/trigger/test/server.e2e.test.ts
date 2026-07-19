import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config/index.js";
import { TriggerServer } from "../src/server.js";

test("embedded Trigger server exposes both listeners with selected services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trigger-server-test-"));
  const server = new TriggerServer(
    loadConfig({
      dataDir: directory,
      controlHost: "127.0.0.1",
      controlPort: 0,
      publicHost: "127.0.0.1",
      publicPort: 0,
      queueIntervalMs: 10,
      schedulerIntervalMs: 20,
    }),
    { builtInDeliveryServices: ["codex-app-server"] },
  );

  try {
    const addresses = await server.start();
    assert.notEqual(addresses.control.port, 0);
    assert.notEqual(addresses.public.port, 0);

    const healthResponse = await fetch(`${addresses.control.origin}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      name: "trigger",
      status: "ok",
      triggerCount: 0,
    });

    const servicesResponse = await fetch(
      `${addresses.control.origin}/v1/delivery-services`,
    );
    assert.equal(servicesResponse.status, 200);
    const body = (await servicesResponse.json()) as {
      services: Array<{ type: string }>;
    };
    assert.deepEqual(
      body.services.map(({ type }) => type),
      ["codex-app-server"],
    );
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
