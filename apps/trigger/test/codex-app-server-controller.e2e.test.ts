import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProcessCodexAppServerController } from "../src/delivery/services/codex-app-server/index.js";

const fakeAppServer = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let nextThread = 1;
let nextTurn = 1;

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "fake-thread-" + nextThread++ } },
    });
    return;
  }
  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: message.params.threadId } },
    });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = "fake-turn-" + nextTurn++;
    const prompt = message.params.input[0]?.text ?? "";
    send({
      id: message.id,
      result: { turn: { id: turnId, status: "inProgress", items: [] } },
    });
    setTimeout(() => {
      const failed = prompt.includes("FAIL");
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: {
            id: turnId,
            status: failed ? "failed" : "completed",
            items: [],
            error: failed ? { message: "simulated Codex failure" } : null,
          },
        },
      });
    }, prompt.includes("SLOW") ? 5_000 : 80);
    return;
  }
  send({ id: message.id, error: { message: "unsupported method" } });
});
`;

async function makeFakeServer(): Promise<{
  directory: string;
  executable: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "trigger-fake-app-server-"));
  const executable = join(directory, "fake-codex-app-server.mjs");
  await writeFile(executable, fakeAppServer);
  await chmod(executable, 0o755);
  return { directory, executable };
}

test("Codex app-server controller waits for turn completion", async () => {
  const fake = await makeFakeServer();
  const controller = new ProcessCodexAppServerController({
    defaultProjectPath: fake.directory,
    executable: fake.executable,
  });
  try {
    let resolved = false;
    const delivery = controller
      .deliver({
        projectPath: "",
        model: "luna",
        reasoningEffort: "medium",
        threadMode: "persistent",
        prompt: "Complete this task",
        images: [],
        signal: new AbortController().signal,
      })
      .then((result) => {
        resolved = true;
        return result;
      });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.equal(resolved, false);
    assert.deepEqual(await delivery, { threadId: "fake-thread-1" });
    assert.equal(resolved, true);
  } finally {
    await controller.shutdown();
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("Codex app-server controller fails when the completed turn fails", async () => {
  const fake = await makeFakeServer();
  const controller = new ProcessCodexAppServerController({
    defaultProjectPath: fake.directory,
    executable: fake.executable,
  });
  try {
    await assert.rejects(
      controller.deliver({
        projectPath: "",
        model: "terra",
        reasoningEffort: "high",
        threadMode: "persistent",
        prompt: "FAIL this task",
        images: [],
        signal: new AbortController().signal,
      }),
      /Codex turn failed: simulated Codex failure/,
    );
  } finally {
    await controller.shutdown();
    await rm(fake.directory, { recursive: true, force: true });
  }
});

test("Codex app-server controller stops waiting when Delivery is aborted", async () => {
  const fake = await makeFakeServer();
  const controller = new ProcessCodexAppServerController({
    defaultProjectPath: fake.directory,
    executable: fake.executable,
  });
  const abortController = new AbortController();
  try {
    const delivery = controller.deliver({
      projectPath: "",
      model: "sol",
      reasoningEffort: "medium",
      threadMode: "persistent",
      prompt: "SLOW task",
      images: [],
      signal: abortController.signal,
    });
    setTimeout(
      () => abortController.abort(new Error("Delivery shutdown")),
      80,
    );
    await assert.rejects(delivery, /Delivery shutdown/);
  } finally {
    await controller.shutdown();
    await rm(fake.directory, { recursive: true, force: true });
  }
});
