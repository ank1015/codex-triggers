import { Hono } from "hono";

import type { SerializedWebhookRequest } from "../domain/types.js";
import type { TriggerSystem } from "../orchestration/trigger-system.js";

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

async function serializeWebhook(
  request: Request,
  maxBytes: number,
): Promise<SerializedWebhookRequest> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new PayloadTooLargeError(`Webhook payload exceeds ${maxBytes} bytes`);
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : Buffer.from(await request.arrayBuffer());
  if (body && body.byteLength > maxBytes) {
    throw new PayloadTooLargeError(`Webhook payload exceeds ${maxBytes} bytes`);
  }

  const headers = Object.fromEntries(request.headers.entries());
  delete headers.authorization;
  delete headers.cookie;

  const url = new URL(request.url);
  url.pathname = "/hooks/v1/redacted";
  url.search = "";
  url.hash = "";

  return {
    method: request.method,
    url: url.toString(),
    headers,
    bodyBase64: body?.toString("base64") ?? null,
  };
}

export function createPublicApp(system: TriggerSystem): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof PayloadTooLargeError) {
      return c.json({ error: error.message }, 413);
    }
    console.error(error);
    return c.json({ error: "Webhook could not be accepted" }, 500);
  });

  app.all("/hooks/v1/:endpointId/:token", async (c) => {
    const request = await serializeWebhook(
      c.req.raw,
      system.config.maxWebhookBytes,
    );
    const execution = system.acceptWebhook({
      endpointId: c.req.param("endpointId"),
      token: c.req.param("token"),
      request,
    });
    return execution
      ? c.json({ accepted: true, executionId: execution.id }, 202)
      : c.json({ error: "Webhook not found" }, 404);
  });

  return app;
}
