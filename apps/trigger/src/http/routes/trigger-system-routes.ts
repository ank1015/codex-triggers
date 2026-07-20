import type { Hono } from "hono";

import { parseCreateDelivery } from "../../delivery/domain/validation.js";
import {
  isRecord,
  parseCreateTrigger,
  ValidationError,
} from "../../domain/validation.js";
import type { TriggerSystem } from "../../orchestration/trigger-system.js";
import { readJson } from "../request-utils.js";

export function registerTriggerSystemRoutes(
  app: Hono,
  system: TriggerSystem,
): void {
  app.post("/v1/trigger-systems", async (c) => {
    const body = await readJson(c.req.raw);
    if (!isRecord(body)) {
      throw new ValidationError("request body must be an object");
    }
    if (!isRecord(body.delivery)) {
      throw new ValidationError("delivery must be an object");
    }

    const trigger = parseCreateTrigger(body.trigger);
    const parsedDelivery = parseCreateDelivery({
      ...body.delivery,
      triggerId: "pending-trigger-id",
    });
    const { triggerId: _triggerId, ...delivery } = parsedDelivery;
    return c.json(
      await system.createTriggerSystem({ trigger, delivery }),
      201,
    );
  });
}
