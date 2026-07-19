import type { Hono } from "hono";

import { ValidationError } from "../../domain/validation.js";
import type { TriggerSystem } from "../../orchestration/trigger-system.js";
import { parseLimit, readJson } from "../../http/request-utils.js";
import type { DeliveryJobStatus } from "../domain/types.js";
import {
  parseCreateDelivery,
  parseUpdateDelivery,
} from "../domain/validation.js";

function parseJobStatus(value: string | undefined): DeliveryJobStatus | undefined {
  if (value === undefined) return undefined;
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new ValidationError(
    "status must be queued, running, succeeded, or failed",
  );
}

export function registerDeliveryRoutes(app: Hono, system: TriggerSystem): void {
  app.get("/v1/delivery-services", (c) =>
    c.json({ services: system.delivery.registry.list() }),
  );

  app.get("/v1/deliveries", (c) => {
    const triggerId = c.req.query("triggerId");
    return c.json({
      deliveries: system.database.delivery.listDeliveries({
        ...(triggerId ? { triggerId } : {}),
      }),
    });
  });

  app.post("/v1/deliveries", async (c) => {
    const input = parseCreateDelivery(await readJson(c.req.raw));
    return c.json({ details: system.delivery.create(input) }, 201);
  });

  app.get("/v1/deliveries/:id", (c) => {
    const details = system.database.delivery.getDetails(c.req.param("id"));
    return details
      ? c.json({ details })
      : c.json({ error: "Delivery not found" }, 404);
  });

  app.patch("/v1/deliveries/:id", async (c) => {
    const update = parseUpdateDelivery(await readJson(c.req.raw));
    const details = system.delivery.update(c.req.param("id"), update);
    return details
      ? c.json({ details })
      : c.json({ error: "Delivery not found" }, 404);
  });

  app.delete("/v1/deliveries/:id", (c) =>
    system.delivery.delete(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ error: "Delivery not found" }, 404),
  );

  app.get("/v1/delivery-jobs", (c) => {
    const deliveryId = c.req.query("deliveryId");
    const notificationId = c.req.query("notificationId");
    const status = parseJobStatus(c.req.query("status"));
    const limit = parseLimit(c.req.query("limit"));
    return c.json({
      jobs: system.database.delivery.listJobs({
        ...(deliveryId ? { deliveryId } : {}),
        ...(notificationId ? { notificationId } : {}),
        ...(status ? { status } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  });

  app.get("/v1/delivery-jobs/:id", (c) => {
    const job = system.database.delivery.getJob(c.req.param("id"));
    return job
      ? c.json({ job })
      : c.json({ error: "Delivery Job not found" }, 404);
  });
}
