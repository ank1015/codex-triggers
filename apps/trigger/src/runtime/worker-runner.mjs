import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

if (!parentPort) throw new Error("Trigger runtime requires a parent port");

const pending = new Map();
const abortController = new AbortController();
let requestSequence = 0;

const printable = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const sendRequest = (type, payload) =>
  new Promise((resolve, reject) => {
    const requestId = `${workerData.executionId}:${++requestSequence}`;
    pending.set(requestId, { resolve, reject });
    parentPort.postMessage({ type, requestId, ...payload });
  });

parentPort.on("message", (message) => {
  if (message?.type === "abort") {
    abortController.abort(message.reason ?? "Trigger stopped");
    return;
  }
  if (message?.type === "request-result") {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error ?? "Host request failed"));
  }
});

const log = (level, values) => {
  parentPort.postMessage({
    type: "log",
    level,
    values: values.map(printable),
    createdAt: new Date().toISOString(),
  });
};

for (const level of ["debug", "info", "warn", "error"]) {
  console[level] = (...values) => log(level, values);
}
console.log = (...values) => log("info", values);

const untilStopped = () =>
  abortController.signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) =>
        abortController.signal.addEventListener("abort", resolve, { once: true }),
      );

const context = Object.freeze({
  triggerId: workerData.triggerId,
  executionId: workerData.executionId,
  signal: abortController.signal,
  secrets: Object.freeze({
    get(name) {
      return Object.hasOwn(workerData.secrets ?? {}, name)
        ? workerData.secrets[name]
        : undefined;
    },
  }),
  notify: async (output) =>
    await sendRequest("notify", {
      output,
    }),
  untilStopped,
  log: Object.freeze({
    debug: (...values) => log("debug", values),
    info: (...values) => log("info", values),
    warn: (...values) => log("warn", values),
    error: (...values) => log("error", values),
  }),
});

const loadComponent = async () => {
  const url = `${pathToFileURL(workerData.modulePath).href}?run=${encodeURIComponent(
    workerData.executionId,
  )}`;
  const imported = await import(url);
  return {
    imported,
    component: imported.default ?? imported,
  };
};

const resolveJobHandler = (component, imported) => {
  if (typeof component === "function") return component;
  if (typeof component?.run === "function") return component.run.bind(component);
  if (typeof imported.run === "function") return imported.run;
  return null;
};

const resolveServiceHandler = (component, imported) => {
  if (typeof component?.start === "function") return component.start.bind(component);
  if (typeof imported.start === "function") return imported.start;
  return null;
};

const finish = (message) => {
  parentPort.postMessage(message);
  parentPort.close();
};

try {
  const { imported, component } = await loadComponent();

  if (workerData.action === "validate") {
    const handler =
      workerData.kind === "service"
        ? resolveServiceHandler(component, imported)
        : resolveJobHandler(component, imported);
    if (!handler) {
      throw new Error(
        workerData.kind === "service"
          ? "Service Trigger must export an object with start(ctx)"
          : "Trigger must export a run function",
      );
    }
    finish({ type: "validated" });
  } else if (workerData.action === "job") {
    const handler = resolveJobHandler(component, imported);
    if (!handler) throw new Error("Trigger must export a run function");

    let result;
    if (workerData.input.type === "webhook") {
      const serialized = workerData.input.request;
      const body = serialized.bodyBase64
        ? Buffer.from(serialized.bodyBase64, "base64")
        : undefined;
      const request = new Request(serialized.url, {
        method: serialized.method,
        headers: serialized.headers,
        body:
          serialized.method === "GET" || serialized.method === "HEAD"
            ? undefined
            : body,
      });
      result = await handler(request, context);
    } else {
      result = await handler(workerData.input, context);
    }

    if (result !== undefined && result !== null) await context.notify(result);
    finish({ type: "completed" });
  } else if (workerData.action === "service") {
    const handler = resolveServiceHandler(component, imported);
    if (!handler) throw new Error("Service Trigger must export an object with start(ctx)");
    parentPort.postMessage({ type: "ready" });
    await handler(context);
    finish({
      type: "completed",
      stopped: abortController.signal.aborted,
    });
  } else {
    throw new Error(`Unknown runtime action: ${workerData.action}`);
  }
} catch (error) {
  finish({
    type: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
