import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  ElectronCodexAppController,
  type CodexAppModel,
  type CodexAppReasoningEffort,
} from "../src/delivery/services/codex-app/index.js";

const enabled = process.env.TRIGGER_LIVE_CODEX_APP_TEST === "1";
const sessionsRoot = resolve(
  process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  "sessions",
);

type SessionEvent = {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    message?: string;
    model?: string;
    effort?: string;
    reasoning_effort?: string;
    thread_settings?: {
      model?: string;
      reasoning_effort?: string;
    };
    content?: Array<{ type?: string; text?: string }>;
  };
  phase?: string;
};

const modelIds: Record<CodexAppModel, string> = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
};

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

async function readEvents(path: string): Promise<SessionEvent[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEvent];
      } catch {
        return [];
      }
    });
}

function eventPrompt(event: SessionEvent): string | null {
  if (event.type === "event_msg" && event.payload?.type === "user_message") {
    return event.payload.message ?? null;
  }
  if (event.type === "response_item" && event.payload?.role === "user") {
    return (
      event.payload.content?.find((item) => item.type === "input_text")?.text ??
      null
    );
  }
  return null;
}

async function waitForTurn(
  threadId: string,
  prompt: string,
  model: CodexAppModel,
  reasoningEffort: CodexAppReasoningEffort,
): Promise<void> {
  const path = await sessionPath(threadId);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = await readEvents(path);
    const promptIndex = events.findIndex((event) =>
      eventPrompt(event)?.trim().endsWith(prompt.trim()),
    );
    if (promptIndex >= 0) {
      const settings = events
        .slice(0, promptIndex)
        .reverse()
        .find(
          (event) =>
            event.type === "event_msg" &&
            event.payload?.type === "thread_settings_applied",
        )?.payload?.thread_settings;
      const context = events
        .slice(0, promptIndex)
        .reverse()
        .find((event) => event.type === "turn_context")?.payload;
      assert.equal(settings?.model ?? context?.model, modelIds[model]);
      assert.equal(
        settings?.reasoning_effort ?? context?.effort,
        reasoningEffort,
      );

      const completed = events.slice(promptIndex + 1).some(
        (event) =>
          (event.type === "event_msg" &&
            event.payload?.type === "agent_message" &&
            event.payload.phase === "final_answer") ||
          (event.type === "response_item" &&
            event.payload?.role === "assistant" &&
            event.phase === "final_answer"),
      );
      if (completed) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Codex did not finish live prompt: ${prompt}`);
}

test(
  "live Codex App hidden worker supports its full configuration surface",
  { skip: !enabled, timeout: 10 * 60_000 },
  async () => {
    const controller = new ElectronCodexAppController({
      appPath: "/Applications/ChatGPT.app",
    });
    const marker = Date.now();
    try {
      const configurations: Array<{
        model: CodexAppModel;
        reasoningEffort: CodexAppReasoningEffort;
      }> = [
        { model: "luna", reasoningEffort: "low" },
        { model: "luna", reasoningEffort: "medium" },
        { model: "luna", reasoningEffort: "high" },
        { model: "luna", reasoningEffort: "xhigh" },
        { model: "terra", reasoningEffort: "medium" },
        { model: "sol", reasoningEffort: "xhigh" },
      ];

      let threadId: string | undefined;
      for (const [index, configuration] of configurations.entries()) {
        const prompt = [
          `TRIGGER_LIVE_MATRIX_${marker}_${index}`,
          `Model ${configuration.model}, effort ${configuration.reasoningEffort}.`,
          "Reply exactly ACK.",
        ].join(" ");
        const result = await controller.deliver({
          projectPath: "",
          ...(threadId ? { threadId } : {}),
          ...configuration,
          prompt,
          attachments:
            index === 0 ? [resolve(process.cwd(), "../../README.md")] : [],
          signal: new AbortController().signal,
        });
        threadId ??= result.threadId;
        assert.equal(result.threadId, threadId);
        await waitForTurn(
          result.threadId,
          prompt,
          configuration.model,
          configuration.reasoningEffort,
        );
      }

      const projectPrompt =
        `TRIGGER_LIVE_PROJECT_${marker}. Reply exactly PROJECT_ACK.`;
      const project = await controller.deliver({
        projectPath: resolve(process.cwd(), "../.."),
        model: "sol",
        reasoningEffort: "medium",
        prompt: projectPrompt,
        attachments: [resolve(process.cwd(), "test")],
        signal: new AbortController().signal,
      });
      assert.notEqual(project.threadId, threadId);
      await waitForTurn(
        project.threadId,
        projectPrompt,
        "sol",
        "medium",
      );
    } finally {
      await controller.shutdown();
    }
  },
);
