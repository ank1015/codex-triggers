import type { Hono } from "hono";

import type { TriggerSystem } from "../../orchestration/trigger-system.js";
import { parseLimit } from "../request-utils.js";

export function registerObservabilityRoutes(
  app: Hono,
  system: TriggerSystem,
): void {
  app.get("/v1/executions", (c) => {
    const triggerId = c.req.query("triggerId");
    const limit = parseLimit(c.req.query("limit"));
    return c.json({
      executions: system.database.listExecutions({
        ...(triggerId ? { triggerId } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  });

  app.get("/v1/executions/:id", (c) => {
    const execution = system.database.getExecution(c.req.param("id"));
    return execution
      ? c.json({
          execution,
          logs: system.database.listLogs(execution.id),
        })
      : c.json({ error: "Execution not found" }, 404);
  });

  app.get("/v1/notifications", (c) => {
    const triggerId = c.req.query("triggerId");
    const limit = parseLimit(c.req.query("limit"));
    return c.json({
      notifications: system.database.listNotifications({
        ...(triggerId ? { triggerId } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  });
}
