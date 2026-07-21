import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { requireCodexAppServerExecutable } from "../../../integrations/codex-app-server-executable.js";

import type {
  CodexAppServerController,
  CodexAppServerModel,
  CodexAppServerRunRequest,
  CodexAppServerRunResult,
} from "./types.js";

const MODEL_IDS: Record<CodexAppServerModel, string> = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
};

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 8_192;

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type ThreadResponse = {
  thread?: { id?: string };
};

type Turn = {
  id?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: unknown;
};

type TurnResponse = {
  turn?: Turn;
};

type TurnCompletedNotification = {
  threadId?: string;
  turn?: Turn;
};

type PendingTurn = {
  resolve(turn: Turn): void;
  reject(error: Error): void;
  cleanup(): void;
};

class CodexAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly completedTurns = new Map<string, Turn>();
  private nextRequestId = 1;
  private stderr = "";
  private exited = false;
  private stopping = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      lines.close();
      const details = this.stderr.trim();
      const reason = this.stopping
        ? "Codex app-server stopped"
        : `Codex app-server exited${
            signal ? ` from ${signal}` : ` with code ${code ?? "unknown"}`
          }${details ? `: ${details}` : ""}`;
      for (const request of this.pending.values()) {
        request.reject(new Error(reason));
      }
      this.pending.clear();
      this.rejectPendingTurns(new Error(reason));
    });
    child.once("error", (error) => {
      this.exited = true;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.rejectPendingTurns(error);
    });
  }

  static async start(executable: string): Promise<CodexAppServerClient> {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new CodexAppServerClient(child);
    try {
      await waitForSpawn(child);
      await Promise.race([
        client.request("initialize", {
          clientInfo: {
            name: "trigger_delivery",
            title: "Trigger Delivery",
            version: "0.1.0",
          },
        }),
        rejectAfter(
          STARTUP_TIMEOUT_MS,
          "Timed out initializing Codex app-server",
        ),
      ]);
      await client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  get closed(): boolean {
    return this.exited;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) throw new Error("Codex app-server is not running");
    const id = this.nextRequestId++;
    const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
    });
    try {
      await this.write({ id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return await response;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.write({ method, params });
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Turn> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return completed;
    }
    if (signal.aborted) throw abortError(signal);

    return await new Promise<Turn>((resolvePromise, rejectPromise) => {
      const abort = () => {
        const pending = this.pendingTurns.get(key);
        if (pending !== waiter) return;
        this.pendingTurns.delete(key);
        waiter.cleanup();
        rejectPromise(abortError(signal));
      };
      const waiter: PendingTurn = {
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      this.pendingTurns.set(key, waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const exited = once(this.child, "exit").then(() => true);
    const timedOut = resolveAfter(STOP_TIMEOUT_MS, false);
    if (!(await Promise.race([exited, timedOut]))) {
      this.child.kill("SIGKILL");
      await once(this.child, "exit").catch(() => undefined);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(
            `Codex app-server ${request.method} failed: ${
              message.error.message ?? "unknown protocol error"
            }`,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      void this.write({
        id: message.id,
        error: {
          code: -32_601,
          message: `Trigger does not support interactive app-server request ${message.method}`,
        },
      });
      return;
    }

    if (message.method === "turn/completed") {
      const completion = message.params as TurnCompletedNotification | undefined;
      const threadId = completion?.threadId;
      const turn = completion?.turn;
      const turnId = turn?.id;
      if (!threadId || !turnId || !turn) return;
      const key = turnKey(threadId, turnId);
      const pending = this.pendingTurns.get(key);
      if (pending) {
        this.pendingTurns.delete(key);
        pending.cleanup();
        pending.resolve(turn);
        return;
      }
      this.completedTurns.set(key, turn);
      while (this.completedTurns.size > 100) {
        const oldest = this.completedTurns.keys().next().value;
        if (oldest === undefined) break;
        this.completedTurns.delete(oldest);
      }
    }
  }

  private rejectPendingTurns(error: Error): void {
    for (const pending of this.pendingTurns.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingTurns.clear();
  }

  private async write(message: JsonRpcMessage): Promise<void> {
    if (this.exited || this.child.stdin.destroyed) {
      throw new Error("Codex app-server is not running");
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex app-server delivery was aborted");
}

function turnError(turn: Turn): string {
  if (typeof turn.error === "object" && turn.error !== null) {
    const message = (turn.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  if (typeof turn.error === "string" && turn.error.trim() !== "") {
    return turn.error;
  }
  return turn.status ?? "unknown status";
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("Timed out starting Codex app-server"));
    }, STARTUP_TIMEOUT_MS);
    timer.unref();
    const onSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds);
    timer.unref();
  });
}

function resolveAfter<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(value), milliseconds);
    timer.unref();
  });
}

export type ProcessCodexAppServerControllerOptions = {
  defaultProjectPath: string;
  executable?: string;
};

export class ProcessCodexAppServerController
  implements CodexAppServerController
{
  private client: CodexAppServerClient | null = null;
  private starting: Promise<CodexAppServerClient> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly options: ProcessCodexAppServerControllerOptions,
  ) {}

  async deliver(
    request: CodexAppServerRunRequest,
  ): Promise<CodexAppServerRunResult> {
    if (this.shuttingDown) {
      throw new Error("Codex app-server delivery is shutting down");
    }
    this.throwIfAborted(request.signal);
    const projectPath = await this.resolveProjectPath(request.projectPath);
    const images = await this.resolveImages(request.images);
    const client = await this.getClient();
    const model = MODEL_IDS[request.model];

    let threadId = request.threadId;
    if (threadId) {
      const result = (await client.request("thread/resume", {
        threadId,
        cwd: projectPath,
        model,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })) as ThreadResponse;
      threadId = result.thread?.id ?? threadId;
    } else {
      const result = (await client.request("thread/start", {
        cwd: projectPath,
        model,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: request.threadMode === "ephemeral",
        serviceName: "trigger",
      })) as ThreadResponse;
      threadId = result.thread?.id;
    }

    if (!threadId) {
      throw new Error("Codex app-server did not return a thread ID");
    }

    const turnResult = (await client.request("turn/start", {
      threadId,
      model,
      effort: request.reasoningEffort,
      input: [
        { type: "text", text: request.prompt },
        ...images,
      ],
    })) as TurnResponse;
    const startedTurn = turnResult.turn;
    const turnId = startedTurn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn ID");

    if (startedTurn.status === "completed") return { threadId };
    if (
      startedTurn.status === "failed" ||
      startedTurn.status === "interrupted"
    ) {
      throw new Error(
        `Codex turn ${startedTurn.status}: ${turnError(startedTurn)}`,
      );
    }

    const completedTurn = await client.waitForTurnCompletion(
      threadId,
      turnId,
      request.signal,
    );
    if (completedTurn.status !== "completed") {
      throw new Error(
        `Codex turn ${completedTurn.status ?? "failed"}: ${turnError(completedTurn)}`,
      );
    }
    return { threadId };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    await this.client?.stop();
    this.client = null;
  }

  private async getClient(): Promise<CodexAppServerClient> {
    if (this.client && !this.client.closed) return this.client;
    if (this.starting) return await this.starting;
    this.starting = (async () =>
      await CodexAppServerClient.start(
        this.options.executable ??
          (await requireCodexAppServerExecutable()),
      ))();
    try {
      this.client = await this.starting;
      return this.client;
    } finally {
      this.starting = null;
    }
  }

  private async resolveProjectPath(projectPath: string): Promise<string> {
    if (projectPath.trim() === "") {
      const path = resolve(this.options.defaultProjectPath);
      await mkdir(path, { recursive: true });
      return path;
    }
    const path = resolve(projectPath);
    const details = await stat(path).catch(() => null);
    if (!details?.isDirectory()) {
      throw new Error(`Codex app-server projectPath is not a directory: ${path}`);
    }
    return path;
  }

  private async resolveImages(
    images: string[],
  ): Promise<Array<Record<string, string>>> {
    return await Promise.all(
      images.map(async (image) => {
        if (/^https?:\/\//i.test(image)) return { type: "image", url: image };
        const path = resolve(image);
        const details = await stat(path).catch(() => null);
        if (!details?.isFile()) {
          throw new Error(`Codex app-server image does not exist: ${path}`);
        }
        return { type: "localImage", path };
      }),
    );
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Codex app-server delivery was aborted");
  }
}
