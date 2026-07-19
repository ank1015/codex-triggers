import { Hono } from "hono";

import { ValidationError } from "../domain/validation.js";
import { registerDeliveryRoutes } from "../delivery/http/delivery-routes.js";
import type { TriggerSystem } from "../orchestration/trigger-system.js";
import { registerObservabilityRoutes } from "./routes/observability-routes.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerTriggerRoutes } from "./routes/trigger-routes.js";

export function createControlApp(system: TriggerSystem): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message, details: error.details }, 400);
    }
    console.error(error);
    return c.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  });

  app.use("/v1/*", async (c, next) => {
    const token = system.config.adminToken;
    if (token && c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      name: "trigger",
      status: "ok",
      triggerCount: system.database.listTriggers().length,
    }),
  );

  registerTriggerRoutes(app, system);
  registerDeliveryRoutes(app, system);
  registerObservabilityRoutes(app, system);
  registerSettingsRoutes(app, system);
  return app;
}
