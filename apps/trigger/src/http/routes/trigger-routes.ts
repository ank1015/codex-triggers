import type { Hono } from "hono";

import {
  asJsonValue,
  isRecord,
  parseCreateTrigger,
  parseUpdateTrigger,
  ValidationError,
} from "../../domain/validation.js";
import type { TriggerSystem } from "../../orchestration/trigger-system.js";
import { readJson } from "../request-utils.js";

export function registerTriggerRoutes(app: Hono, system: TriggerSystem): void {
  app.get("/v1/triggers", (c) =>
    c.json({ triggers: system.database.listTriggers() }),
  );

  app.post("/v1/triggers", async (c) => {
    const input = parseCreateTrigger(await readJson(c.req.raw));
    const created = await system.createTrigger(input);
    return c.json(created, 201);
  });

  app.get("/v1/triggers/:id", (c) => {
    const details = system.database.getDetails(c.req.param("id"));
    return details
      ? c.json({ details })
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.patch("/v1/triggers/:id", async (c) => {
    const id = c.req.param("id");
    const trigger = system.database.getTrigger(id);
    if (!trigger) return c.json({ error: "Trigger not found" }, 404);
    const update = parseUpdateTrigger(await readJson(c.req.raw), trigger.kind);
    const details = await system.updateTrigger(id, update);
    return c.json({ details });
  });

  app.delete("/v1/triggers/:id", async (c) => {
    const deleted = await system.deleteTrigger(c.req.param("id"));
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.get("/v1/triggers/:id/revisions", (c) => {
    const trigger = system.database.getTrigger(c.req.param("id"));
    return trigger
      ? c.json({ revisions: system.database.listRevisions(trigger.id) })
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.post("/v1/triggers/:id/revisions/:revisionId/activate", async (c) => {
    const details = await system.activateRevision(
      c.req.param("id"),
      c.req.param("revisionId"),
    );
    return details
      ? c.json({ details })
      : c.json({ error: "Trigger revision not found" }, 404);
  });

  app.post("/v1/triggers/:id/rotate-webhook", (c) => {
    const result = system.rotateWebhook(c.req.param("id"));
    return result
      ? c.json(result)
      : c.json({ error: "Webhook Trigger not found" }, 404);
  });

  app.get("/v1/triggers/:id/secrets", (c) => {
    const trigger = system.database.getTrigger(c.req.param("id"));
    return trigger
      ? c.json({ names: system.database.listSecretNames(trigger.id) })
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.put("/v1/triggers/:id/secrets/:name", async (c) => {
    const body = await readJson(c.req.raw);
    if (!isRecord(body) || typeof body.value !== "string") {
      throw new ValidationError("value must be a string");
    }
    const names = await system.setSecret(
      c.req.param("id"),
      c.req.param("name"),
      body.value,
    );
    return c.json({ configured: true, names });
  });

  app.delete("/v1/triggers/:id/secrets/:name", async (c) => {
    const deleted = await system.deleteSecret(
      c.req.param("id"),
      c.req.param("name"),
    );
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "Secret not found" }, 404);
  });

  app.post("/v1/triggers/:id/run", async (c) => {
    const body = await readJson(c.req.raw);
    const payload = asJsonValue(
      isRecord(body) && Object.hasOwn(body, "payload") ? body.payload : body,
      "payload",
    );
    const execution = system.runManually(c.req.param("id"), payload);
    return execution
      ? c.json({ execution }, 202)
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.post("/v1/triggers/:id/start", async (c) => {
    const details = await system.setServiceEnabled(c.req.param("id"), true);
    return details
      ? c.json({ details })
      : c.json({ error: "Trigger not found" }, 404);
  });

  app.post("/v1/triggers/:id/stop", async (c) => {
    const details = await system.setServiceEnabled(c.req.param("id"), false);
    return details
      ? c.json({ details })
      : c.json({ error: "Trigger not found" }, 404);
  });
}
