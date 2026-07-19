import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { JsonValue, Notification } from "../../domain/types.js";
import type {
  Delivery,
  DeliveryDetails,
  DeliveryJob,
  DeliveryJobStatus,
  DeliveryTarget,
} from "../domain/types.js";

type DeliveryRow = {
  id: string;
  name: string;
  trigger_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type DeliveryTargetRow = {
  id: string;
  delivery_id: string;
  service_type: string;
  config_json: string;
  input_json: string;
  created_at: string;
  updated_at: string;
};

type DeliveryJobRow = {
  id: string;
  delivery_id: string;
  delivery_target_id: string;
  notification_id: string;
  service_type: string;
  config_json: string;
  input_json: string;
  status: DeliveryJobStatus;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const deliveryFromRow = (row: DeliveryRow): Delivery => ({
  id: row.id,
  name: row.name,
  triggerId: row.trigger_id,
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const targetFromRow = (row: DeliveryTargetRow): DeliveryTarget => ({
  id: row.id,
  deliveryId: row.delivery_id,
  type: row.service_type,
  config: JSON.parse(row.config_json) as Record<string, JsonValue>,
  input: JSON.parse(row.input_json) as Record<string, JsonValue>,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const jobFromRow = (row: DeliveryJobRow): DeliveryJob => ({
  id: row.id,
  deliveryId: row.delivery_id,
  configuredServiceId: row.delivery_target_id,
  notificationId: row.notification_id,
  serviceType: row.service_type,
  config: JSON.parse(row.config_json) as Record<string, JsonValue>,
  input: JSON.parse(row.input_json) as Record<string, JsonValue>,
  status: row.status,
  result: row.result_json === null ? null : (JSON.parse(row.result_json) as JsonValue),
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export class DeliveryRepository {
  constructor(private readonly database: DatabaseSync) {}

  migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delivery_targets (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        service_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delivery_jobs (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        delivery_target_id TEXT NOT NULL,
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        service_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(notification_id, delivery_target_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_trigger_created
        ON deliveries(trigger_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS delivery_jobs_status_created
        ON delivery_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS delivery_jobs_delivery_created
        ON delivery_jobs(delivery_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS delivery_jobs_notification
        ON delivery_jobs(notification_id);
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createDelivery(delivery: Delivery, targets: DeliveryTarget[]): DeliveryDetails {
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO deliveries (
            id, name, trigger_id, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          delivery.id,
          delivery.name,
          delivery.triggerId,
          delivery.enabled ? 1 : 0,
          delivery.createdAt,
          delivery.updatedAt,
        );
      for (const target of targets) this.insertTarget(target);
    });
    return this.getDetails(delivery.id)!;
  }

  private insertTarget(target: DeliveryTarget): void {
    this.database
      .prepare(`
        INSERT INTO delivery_targets (
          id, delivery_id, service_type, config_json, input_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        target.id,
        target.deliveryId,
        target.type,
        JSON.stringify(target.config),
        JSON.stringify(target.input),
        target.createdAt,
        target.updatedAt,
      );
  }

  listDeliveries(options: { triggerId?: string } = {}): Delivery[] {
    const rows = options.triggerId
      ? (this.database
          .prepare(
            "SELECT * FROM deliveries WHERE trigger_id = ? ORDER BY created_at DESC",
          )
          .all(options.triggerId) as unknown as DeliveryRow[])
      : (this.database
          .prepare("SELECT * FROM deliveries ORDER BY created_at DESC")
          .all() as unknown as DeliveryRow[]);
    return rows.map(deliveryFromRow);
  }

  getDelivery(id: string): Delivery | null {
    const row = this.database
      .prepare("SELECT * FROM deliveries WHERE id = ?")
      .get(id) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : null;
  }

  getTargets(deliveryId: string): DeliveryTarget[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM delivery_targets WHERE delivery_id = ? ORDER BY created_at ASC",
        )
        .all(deliveryId) as unknown as DeliveryTargetRow[]
    ).map(targetFromRow);
  }

  getDetails(id: string): DeliveryDetails | null {
    const delivery = this.getDelivery(id);
    return delivery
      ? { delivery, services: this.getTargets(delivery.id) }
      : null;
  }

  updateDelivery(
    id: string,
    update: {
      name?: string;
      enabled?: boolean;
      targets?: DeliveryTarget[];
    },
  ): DeliveryDetails | null {
    return this.transaction(() => {
      const delivery = this.getDelivery(id);
      if (!delivery) return null;
      const now = new Date().toISOString();
      this.database
        .prepare(
          "UPDATE deliveries SET name = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          update.name ?? delivery.name,
          (update.enabled ?? delivery.enabled) ? 1 : 0,
          now,
          id,
        );
      if (update.targets) {
        this.database
          .prepare("DELETE FROM delivery_targets WHERE delivery_id = ?")
          .run(id);
        for (const target of update.targets) this.insertTarget(target);
      }
      return this.getDetails(id);
    });
  }

  updateTargetConfig(
    targetId: string,
    config: Record<string, JsonValue>,
  ): boolean {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const configJson = JSON.stringify(config);
      const updated = this.database
        .prepare(`
          UPDATE delivery_targets SET config_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(configJson, now, targetId);
      if (updated.changes === 0) return false;

      this.database
        .prepare(`
          UPDATE delivery_jobs SET config_json = ?
          WHERE delivery_target_id = ? AND status = 'queued'
        `)
        .run(configJson, targetId);
      return true;
    });
  }

  deleteDelivery(id: string): boolean {
    return (
      this.database.prepare("DELETE FROM deliveries WHERE id = ?").run(id).changes > 0
    );
  }

  planJobsForNotification(notification: Notification): number {
    const targets = this.database
      .prepare(`
        SELECT t.* FROM delivery_targets t
        JOIN deliveries d ON d.id = t.delivery_id
        WHERE d.trigger_id = ? AND d.enabled = 1
        ORDER BY d.created_at ASC, t.created_at ASC
      `)
      .all(notification.triggerId) as unknown as DeliveryTargetRow[];

    let created = 0;
    for (const target of targets) {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO delivery_jobs (
            id, delivery_id, delivery_target_id, notification_id,
            service_type, config_json, input_json, status, result_json,
            error, created_at, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL)
        `)
        .run(
          randomUUID(),
          target.delivery_id,
          target.id,
          notification.id,
          target.service_type,
          target.config_json,
          target.input_json,
          notification.createdAt,
        );
      created += Number(result.changes);
    }
    return created;
  }

  claimNextJob(): DeliveryJob | null {
    return this.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT * FROM delivery_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
        )
        .get() as DeliveryJobRow | undefined;
      if (!row) return null;
      const result = this.database
        .prepare(
          "UPDATE delivery_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(new Date().toISOString(), row.id);
      return result.changes === 0 ? null : this.getJob(row.id);
    });
  }

  finishJob(
    id: string,
    status: "succeeded" | "failed",
    result: JsonValue | null,
    error: string | null,
  ): DeliveryJob | null {
    const update = this.database
      .prepare(`
        UPDATE delivery_jobs SET
          status = ?, result_json = ?, error = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(
        status,
        result === null ? null : JSON.stringify(result),
        error,
        new Date().toISOString(),
        id,
      );
    return update.changes === 0 ? null : this.getJob(id);
  }

  recoverRunningJobs(): number {
    return Number(
      this.database
        .prepare(`
          UPDATE delivery_jobs SET
            status = 'failed', error = 'Delivery host restarted during job',
            finished_at = ?
          WHERE status = 'running'
        `)
        .run(new Date().toISOString()).changes,
    );
  }

  getJob(id: string): DeliveryJob | null {
    const row = this.database
      .prepare("SELECT * FROM delivery_jobs WHERE id = ?")
      .get(id) as DeliveryJobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  listJobs(
    options: {
      deliveryId?: string;
      notificationId?: string;
      status?: DeliveryJobStatus;
      limit?: number;
    } = {},
  ): DeliveryJob[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.deliveryId) {
      conditions.push("delivery_id = ?");
      parameters.push(options.deliveryId);
    }
    if (options.notificationId) {
      conditions.push("notification_id = ?");
      parameters.push(options.notificationId);
    }
    if (options.status) {
      conditions.push("status = ?");
      parameters.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    parameters.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.database
        .prepare(
          `SELECT * FROM delivery_jobs ${where} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...parameters) as unknown as DeliveryJobRow[]
    ).map(jobFromRow);
  }
}
