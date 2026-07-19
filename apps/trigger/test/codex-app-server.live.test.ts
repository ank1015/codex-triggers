import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { ProcessCodexAppServerController } from "../src/delivery/services/codex-app-server/index.js";
import { loadConfig } from "../src/config/index.js";
import type { JsonValue } from "../src/domain/types.js";
import { TriggerSystem } from "../src/orchestration/trigger-system.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.TRIGGER_LIVE_CODEX_APP_SERVER_TEST === "1";
const sessionsRoot = resolve(
  process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  "sessions",
);

async function sessionPath(threadId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entries = await readdir(sessionsRoot, { recursive: true });
    const entry = entries.find(
      (candidate) => candidate.endsWith(".jsonl") && candidate.includes(threadId),
    );
    if (entry) return join(sessionsRoot, entry);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Session file was not found for ${threadId}`);
}

async function waitForCompletedPrompt(
  threadId: string,
  prompt: string,
): Promise<void> {
  const path = await sessionPath(threadId);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { type?: string; payload?: unknown }];
        } catch {
          return [];
        }
      });
    const promptIndex = events.findIndex((event) =>
      JSON.stringify(event.payload).includes(prompt),
    );
    if (
      promptIndex >= 0 &&
      events.slice(promptIndex + 1).some(
        (event) =>
          event.type === "event_msg" &&
          (event.payload as { type?: string } | undefined)?.type ===
            "task_complete",
      )
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Codex app-server did not complete prompt: ${prompt}`);
}

async function sessionExists(threadId: string): Promise<boolean> {
  const entries = await readdir(sessionsRoot, { recursive: true });
  return entries.some(
    (candidate) => candidate.endsWith(".jsonl") && candidate.includes(threadId),
  );
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw lastError ?? new Error("Condition was not met");
}

test(
  "live Codex app-server supports persistent, resumed, and ephemeral delivery",
  { skip: !enabled, timeout: 8 * 60_000 },
  async () => {
    const controller = new ProcessCodexAppServerController({
      defaultProjectPath: resolve(tmpdir(), "trigger-codex-app-server-live"),
    });
    const marker = Date.now();
    const imagePath = resolve(tmpdir(), `trigger-app-server-${marker}.png`);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(imagePath, png);
    let persistentThreadId: string | null = null;
    try {
      const firstPrompt =
        `TRIGGER_APP_SERVER_PERSISTENT_${marker}. Reply exactly ACK.`;
      const first = await controller.deliver({
        projectPath: resolve(process.cwd(), "../.."),
        model: "luna",
        reasoningEffort: "medium",
        threadMode: "persistent",
        prompt: firstPrompt,
        images: [imagePath],
        signal: new AbortController().signal,
      });
      persistentThreadId = first.threadId;
      await waitForCompletedPrompt(first.threadId, firstPrompt);

      const secondPrompt =
        `TRIGGER_APP_SERVER_RESUME_${marker}. Reply exactly CONTINUED.`;
      const second = await controller.deliver({
        projectPath: resolve(process.cwd(), "../.."),
        threadId: first.threadId,
        model: "terra",
        reasoningEffort: "high",
        threadMode: "persistent",
        prompt: secondPrompt,
        images: [],
        signal: new AbortController().signal,
      });
      assert.equal(second.threadId, first.threadId);
      await waitForCompletedPrompt(second.threadId, secondPrompt);

      const ephemeral = await controller.deliver({
        projectPath: "",
        model: "sol",
        reasoningEffort: "xhigh",
        threadMode: "ephemeral",
        prompt: `TRIGGER_APP_SERVER_EPHEMERAL_${marker}. Reply exactly HIDDEN.`,
        images: [],
        signal: new AbortController().signal,
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      assert.equal(await sessionExists(ephemeral.threadId), false);
    } finally {
      await controller.shutdown();
      if (persistentThreadId) {
        await execFileAsync("codex", ["delete", "--force", persistentThreadId]);
      }
      await rm(imagePath, { force: true });
    }
  },
);

test(
  "live Trigger pipeline delivers through Codex app-server",
  { skip: !enabled, timeout: 6 * 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "trigger-app-server-live-"));
    const system = new TriggerSystem(
      loadConfig({
        dataDir: directory,
        queueIntervalMs: 10,
        schedulerIntervalMs: 20,
        serviceStopTimeoutMs: 500,
      }),
    );
    const marker = Date.now();
    let threadId: string | null = null;
    try {
      await system.start();
      const trigger = await system.createTrigger({
        name: "Live app-server pipeline source",
        kind: "schedule",
        enabled: true,
        code: `
          export default function run(_event, ctx) {
            return {
              message: "TRIGGER_APP_SERVER_PIPELINE_${marker}_" + ctx.executionId,
              data: {},
            }
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
      const delivery = system.delivery.create({
        name: "Live app-server pipeline destination",
        triggerId: trigger.details.trigger.id,
        enabled: true,
        services: [
          {
            type: "codex-app-server",
            config: {
              projectPath: resolve(process.cwd(), "../.."),
              newThread: false,
              model: "luna",
              reasoningEffort: "low",
              threadMode: "persistent",
            },
            input: {
              prompt: "{{message}}. Reply exactly PIPELINE_ACK.",
            },
          },
        ],
      });

      const first = system.runManually(
        trigger.details.trigger.id,
        {} as JsonValue,
      )!;
      await waitFor(() => {
        const job = system.database.delivery.listJobs({
          deliveryId: delivery.delivery.id,
        })[0];
        assert.equal(job?.status, "succeeded");
      });
      threadId = String(
        system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
          ?.config.threadId,
      );
      assert.notEqual(threadId, "undefined");
      await waitForCompletedPrompt(
        threadId,
        `TRIGGER_APP_SERVER_PIPELINE_${marker}_${first.id}`,
      );

      const second = system.runManually(
        trigger.details.trigger.id,
        {} as JsonValue,
      )!;
      await waitFor(() => {
        const jobs = system.database.delivery.listJobs({
          deliveryId: delivery.delivery.id,
        });
        assert.equal(jobs.length, 2);
        assert.equal(jobs.every((job) => job.status === "succeeded"), true);
      });
      assert.equal(
        system.database.delivery.getDetails(delivery.delivery.id)?.services[0]
          ?.config.threadId,
        threadId,
      );
      await waitForCompletedPrompt(
        threadId,
        `TRIGGER_APP_SERVER_PIPELINE_${marker}_${second.id}`,
      );
    } finally {
      await system.stop();
      system.close();
      await rm(directory, { recursive: true, force: true });
      if (threadId) {
        await execFileAsync("codex", ["delete", "--force", threadId]);
      }
    }
  },
);
