import type { Hono } from "hono";

import { isRecord, ValidationError } from "../../domain/validation.js";
import type { TriggerSystem } from "../../orchestration/trigger-system.js";
import { readJson } from "../request-utils.js";

export function registerSettingsRoutes(app: Hono, system: TriggerSystem): void {
  app.get("/v1/settings/webhook-tunnel", async (c) =>
    c.json(await system.getWebhookTunnelStatus()),
  );

  app.put("/v1/settings/webhook-tunnel", async (c) => {
    const body = await readJson(c.req.raw);
    if (!isRecord(body) || typeof body.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean");
    }
    return c.json(await system.setWebhookTunnelEnabled(body.enabled));
  });

  app.get("/v1/public-webhook-url", async (c) =>
    c.json(await system.getPublicWebhookUrlStatus()),
  );
}
