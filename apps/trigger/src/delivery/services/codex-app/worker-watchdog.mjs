import { execFile } from "node:child_process";
import { promisify } from "node:util";

import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const parentPid = Number(process.argv[2]);
const ownerToken = process.argv[3];
const codexExecutable = process.argv[4];
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function codexPid() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const pids = stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(
      (match) =>
        match &&
        (match[2] === codexExecutable ||
          match[2].startsWith(`${codexExecutable} `)),
    )
    .map((match) => Number(match[1]));
  return pids.length ? Math.min(...pids) : null;
}

async function inspectorPages() {
  const pages = [];
  await Promise.all(
    Array.from({ length: 21 }, (_, index) => 9_229 + index).map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(200),
        });
        if (response.ok) pages.push(...(await response.json()));
      } catch {
        // Most ports are expected to be closed.
      }
    }),
  );
  return pages;
}

function evaluate(url, expression) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectPromise(new Error("Inspector connection timed out"));
    }, 5_000);
    socket.once("error", rejectPromise);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      resolvePromise(message.result?.result?.value);
    });
  });
}

async function closeOwnedWorker() {
  const pid = await codexPid();
  if (!pid) return;
  process.kill(pid, "SIGUSR1");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const page of await inspectorPages()) {
      if (!page.webSocketDebuggerUrl) continue;
      try {
        const closed = await evaluate(
          page.webSocketDebuggerUrl,
          `(() => {
            if (globalThis.__triggerCodexWorkerOwner !== ${JSON.stringify(ownerToken)}) {
              return false;
            }
            const {BrowserWindow} = process.mainModule.require('electron');
            const workerId = globalThis.__triggerCodexWorkerId;
            const worker = workerId == null ? null : BrowserWindow.fromId(workerId);
            globalThis.__triggerCodexWorkerId = null;
            globalThis.__triggerCodexWorkerOwner = null;
            if (worker != null && !worker.isDestroyed()) worker.destroy();
            setTimeout(() => process.mainModule.require('inspector').close(), 50);
            return true;
          })()`,
        );
        if (closed) return;
      } catch {
        // This inspector target may belong to another Node process.
      }
    }
    await delay(100);
  }
}

if (
  Number.isInteger(parentPid) &&
  parentPid > 0 &&
  ownerToken &&
  codexExecutable
) {
  while (processExists(parentPid)) await delay(250);
  await delay(250);
  await closeOwnedWorker();
}
