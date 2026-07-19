import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Execution,
  ExecutionKind,
  ExecutionLog,
  JsonSchema,
  JsonValue,
  Notification,
  ServiceState,
  Trigger,
  TriggerDetails,
  TriggerKind,
  TriggerOutput,
  TriggerRevision,
  TriggerSchedule,
  WebhookEndpoint,
} from "../domain/types.js";
import { DeliveryRepository } from "../delivery/persistence/delivery-repository.js";

type TriggerRow = {
  id: string;
  name: string;
  kind: TriggerKind;
  enabled: number;
  active_revision_id: string;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: string;
  trigger_id: string;
  version: number;
  code: string;
  output_schema_json: string;
  timeout_ms: number;
  created_at: string;
};

type WebhookRow = {
  id: string;
  trigger_id: string;
  token_hash: string;
  created_at: string;
  rotated_at: string | null;
};

type ScheduleRow = {
  id: string;
  trigger_id: string;
  kind: TriggerSchedule["kind"];
  expression: string;
  timezone: string;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type ExecutionRow = {
  id: string;
  trigger_id: string;
  revision_id: string;
  kind: ExecutionKind;
  status: Execution["status"];
  input_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type NotificationRow = {
  id: string;
  trigger_id: string;
  execution_id: string;
  output_json: string;
  status: "recorded";
  created_at: string;
};

type LogRow = {
  id: number;
  trigger_id: string;
  execution_id: string;
  level: ExecutionLog["level"];
  values_json: string;
  created_at: string;
};

type ServiceStateRow = {
  trigger_id: string;
  status: ServiceState["status"];
  restart_count: number;
  last_error: string | null;
  updated_at: string;
};

const triggerFromRow = (row: TriggerRow): Trigger => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  enabled: Boolean(row.enabled),
  activeRevisionId: row.active_revision_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const revisionFromRow = (row: RevisionRow): TriggerRevision => ({
  id: row.id,
  triggerId: row.trigger_id,
  version: row.version,
  code: row.code,
  outputSchema: JSON.parse(row.output_schema_json) as JsonSchema,
  timeoutMs: row.timeout_ms,
  createdAt: row.created_at,
});

const webhookFromRow = (row: WebhookRow): WebhookEndpoint => ({
  id: row.id,
  triggerId: row.trigger_id,
  tokenHash: row.token_hash,
  createdAt: row.created_at,
  rotatedAt: row.rotated_at,
});

const scheduleFromRow = (row: ScheduleRow): TriggerSchedule => ({
  id: row.id,
  triggerId: row.trigger_id,
  kind: row.kind,
  expression: row.expression,
  timezone: row.timezone,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const executionFromRow = (row: ExecutionRow): Execution => ({
  id: row.id,
  triggerId: row.trigger_id,
  revisionId: row.revision_id,
  kind: row.kind,
  status: row.status,
  input: JSON.parse(row.input_json) as JsonValue,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const notificationFromRow = (row: NotificationRow): Notification => ({
  id: row.id,
  triggerId: row.trigger_id,
  executionId: row.execution_id,
  output: JSON.parse(row.output_json) as TriggerOutput,
  status: row.status,
  createdAt: row.created_at,
});

const logFromRow = (row: LogRow): ExecutionLog => ({
  id: row.id,
  triggerId: row.trigger_id,
  executionId: row.execution_id,
  level: row.level,
  values: JSON.parse(row.values_json) as string[],
  createdAt: row.created_at,
});

const serviceStateFromRow = (row: ServiceStateRow): ServiceState => ({
  triggerId: row.trigger_id,
  status: row.status,
  restartCount: row.restart_count,
  lastError: row.last_error,
  updatedAt: row.updated_at,
});

export class TriggerDatabase {
  private readonly database: DatabaseSync;
  readonly delivery: DeliveryRepository;

  constructor(path: string) {
    const databasePath = resolve(path);
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.delivery = new DeliveryRepository(this.database);
    this.delivery.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('webhook', 'schedule', 'service')),
        enabled INTEGER NOT NULL,
        active_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger_revisions (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        code TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(trigger_id, version)
      );

      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rotated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('cron', 'once')),
        expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES trigger_revisions(id),
        kind TEXT NOT NULL CHECK (kind IN ('webhook', 'schedule', 'manual', 'service')),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'interrupted')
        ),
        input_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        values_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        output_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'recorded'),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS service_states (
        trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'failed')),
        restart_count INTEGER NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger_secrets (
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(trigger_id, name)
      );

      CREATE INDEX IF NOT EXISTS executions_status_created
        ON executions(status, created_at);
      CREATE INDEX IF NOT EXISTS executions_trigger_created
        ON executions(trigger_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS notifications_created
        ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS schedules_next_run
        ON schedules(next_run_at);
    `);
  }

  transaction<T>(operation: () => T): T {
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

  createTrigger(input: {
    trigger: Trigger;
    revision: TriggerRevision;
    webhook?: WebhookEndpoint;
    schedule?: TriggerSchedule;
  }): void {
    this.transaction(() => {
      const { trigger, revision } = input;
      this.database
        .prepare(`
          INSERT INTO triggers (
            id, name, kind, enabled, active_revision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          trigger.id,
          trigger.name,
          trigger.kind,
          trigger.enabled ? 1 : 0,
          trigger.activeRevisionId,
          trigger.createdAt,
          trigger.updatedAt,
        );
      this.insertRevision(revision);
      if (input.webhook) {
        this.database
          .prepare(`
            INSERT INTO webhook_endpoints (
              id, trigger_id, token_hash, created_at, rotated_at
            ) VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            input.webhook.id,
            input.webhook.triggerId,
            input.webhook.tokenHash,
            input.webhook.createdAt,
            input.webhook.rotatedAt,
          );
      }
      if (input.schedule) this.insertSchedule(input.schedule);
      if (trigger.kind === "service") {
        this.setServiceState(trigger.id, "stopped", 0, null);
      }
    });
  }

  private insertRevision(revision: TriggerRevision): void {
    this.database
      .prepare(`
        INSERT INTO trigger_revisions (
          id, trigger_id, version, code, output_schema_json, timeout_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        revision.id,
        revision.triggerId,
        revision.version,
        revision.code,
        JSON.stringify(revision.outputSchema),
        revision.timeoutMs,
        revision.createdAt,
      );
  }

  private insertSchedule(schedule: TriggerSchedule): void {
    this.database
      .prepare(`
        INSERT INTO schedules (
          id, trigger_id, kind, expression, timezone, next_run_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        schedule.id,
        schedule.triggerId,
        schedule.kind,
        schedule.expression,
        schedule.timezone,
        schedule.nextRunAt,
        schedule.createdAt,
        schedule.updatedAt,
      );
  }

  addRevision(revision: TriggerRevision): void {
    this.transaction(() => {
      this.insertRevision(revision);
      this.database
        .prepare(
          "UPDATE triggers SET active_revision_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(revision.id, revision.createdAt, revision.triggerId);
    });
  }

  listTriggers(): Trigger[] {
    return (
      this.database
        .prepare("SELECT * FROM triggers ORDER BY created_at DESC")
        .all() as unknown as TriggerRow[]
    ).map(triggerFromRow);
  }

  getTrigger(id: string): Trigger | null {
    const row = this.database
      .prepare("SELECT * FROM triggers WHERE id = ?")
      .get(id) as TriggerRow | undefined;
    return row ? triggerFromRow(row) : null;
  }

  getRevision(id: string): TriggerRevision | null {
    const row = this.database
      .prepare("SELECT * FROM trigger_revisions WHERE id = ?")
      .get(id) as RevisionRow | undefined;
    return row ? revisionFromRow(row) : null;
  }

  getActiveRevision(triggerId: string): TriggerRevision | null {
    const row = this.database
      .prepare(`
        SELECT r.* FROM trigger_revisions r
        JOIN triggers t ON t.active_revision_id = r.id
        WHERE t.id = ?
      `)
      .get(triggerId) as RevisionRow | undefined;
    return row ? revisionFromRow(row) : null;
  }

  listRevisions(triggerId: string): TriggerRevision[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM trigger_revisions WHERE trigger_id = ? ORDER BY version DESC",
        )
        .all(triggerId) as unknown as RevisionRow[]
    ).map(revisionFromRow);
  }

  activateRevision(triggerId: string, revisionId: string): Trigger | null {
    const revision = this.database
      .prepare(
        "SELECT id FROM trigger_revisions WHERE id = ? AND trigger_id = ?",
      )
      .get(revisionId, triggerId);
    if (!revision) return null;
    this.database
      .prepare(
        "UPDATE triggers SET active_revision_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(revisionId, new Date().toISOString(), triggerId);
    return this.getTrigger(triggerId);
  }

  nextRevisionVersion(triggerId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM trigger_revisions WHERE trigger_id = ?",
      )
      .get(triggerId) as { version: number };
    return row.version;
  }

  updateTriggerMetadata(
    id: string,
    update: { name?: string; enabled?: boolean },
  ): Trigger | null {
    const trigger = this.getTrigger(id);
    if (!trigger) return null;
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE triggers SET name = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(
        update.name ?? trigger.name,
        (update.enabled ?? trigger.enabled) ? 1 : 0,
        now,
        id,
      );
    return this.getTrigger(id);
  }

  deleteTrigger(id: string): boolean {
    return this.database.prepare("DELETE FROM triggers WHERE id = ?").run(id)
      .changes > 0;
  }

  getWebhookByTrigger(triggerId: string): WebhookEndpoint | null {
    const row = this.database
      .prepare("SELECT * FROM webhook_endpoints WHERE trigger_id = ?")
      .get(triggerId) as WebhookRow | undefined;
    return row ? webhookFromRow(row) : null;
  }

  getWebhookById(id: string): WebhookEndpoint | null {
    const row = this.database
      .prepare("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id) as WebhookRow | undefined;
    return row ? webhookFromRow(row) : null;
  }

  rotateWebhook(id: string, tokenHash: string): WebhookEndpoint | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        "UPDATE webhook_endpoints SET token_hash = ?, rotated_at = ? WHERE id = ?",
      )
      .run(tokenHash, now, id);
    return result.changes === 0 ? null : this.getWebhookById(id);
  }

  getScheduleByTrigger(triggerId: string): TriggerSchedule | null {
    const row = this.database
      .prepare("SELECT * FROM schedules WHERE trigger_id = ?")
      .get(triggerId) as ScheduleRow | undefined;
    return row ? scheduleFromRow(row) : null;
  }

  listDueSchedules(now: string): TriggerSchedule[] {
    return (
      this.database
        .prepare(`
          SELECT s.* FROM schedules s
          JOIN triggers t ON t.id = s.trigger_id
          WHERE t.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?
          ORDER BY s.next_run_at ASC
        `)
        .all(now) as unknown as ScheduleRow[]
    ).map(scheduleFromRow);
  }

  updateSchedule(
    triggerId: string,
    update: {
      kind: TriggerSchedule["kind"];
      expression: string;
      timezone: string;
      nextRunAt: string | null;
    },
  ): TriggerSchedule | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE schedules SET
          kind = ?, expression = ?, timezone = ?, next_run_at = ?, updated_at = ?
        WHERE trigger_id = ?
      `)
      .run(
        update.kind,
        update.expression,
        update.timezone,
        update.nextRunAt,
        now,
        triggerId,
      );
    return result.changes === 0 ? null : this.getScheduleByTrigger(triggerId);
  }

  advanceSchedule(
    id: string,
    expectedRunAt: string,
    nextRunAt: string | null,
  ): boolean {
    const result = this.database
      .prepare(`
        UPDATE schedules SET next_run_at = ?, updated_at = ?
        WHERE id = ? AND next_run_at = ?
      `)
      .run(nextRunAt, new Date().toISOString(), id, expectedRunAt);
    return result.changes > 0;
  }

  enqueueScheduledExecution(input: {
    scheduleId: string;
    expectedRunAt: string;
    nextRunAt: string | null;
    executionId: string;
    triggerId: string;
    revisionId: string;
    event: JsonValue;
  }): Execution | null {
    return this.transaction(() => {
      if (
        !this.advanceSchedule(
          input.scheduleId,
          input.expectedRunAt,
          input.nextRunAt,
        )
      ) {
        return null;
      }
      return this.createExecution({
        id: input.executionId,
        triggerId: input.triggerId,
        revisionId: input.revisionId,
        kind: "schedule",
        event: input.event,
      });
    });
  }

  getDetails(id: string): TriggerDetails | null {
    const trigger = this.getTrigger(id);
    if (!trigger) return null;
    const revision = this.getRevision(trigger.activeRevisionId);
    if (!revision) throw new Error(`Active revision missing for Trigger ${id}`);
    const webhook = this.getWebhookByTrigger(id);
    const schedule = this.getScheduleByTrigger(id);
    const serviceState = this.getServiceState(id);
    return {
      trigger,
      revision,
      webhook: webhook
        ? {
            id: webhook.id,
            triggerId: webhook.triggerId,
            createdAt: webhook.createdAt,
            rotatedAt: webhook.rotatedAt,
          }
        : null,
      schedule,
      serviceState,
    };
  }

  createExecution(input: {
    id: string;
    triggerId: string;
    revisionId: string;
    kind: ExecutionKind;
    status?: "queued" | "running";
    event: JsonValue;
  }): Execution {
    const now = new Date().toISOString();
    const status = input.status ?? "queued";
    this.database
      .prepare(`
        INSERT INTO executions (
          id, trigger_id, revision_id, kind, status, input_json, error,
          created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
      `)
      .run(
        input.id,
        input.triggerId,
        input.revisionId,
        input.kind,
        status,
        JSON.stringify(input.event),
        now,
        status === "running" ? now : null,
      );
    return this.getExecution(input.id)!;
  }

  claimNextExecution(): Execution | null {
    return this.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT * FROM executions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
        )
        .get() as ExecutionRow | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      const update = this.database
        .prepare(
          "UPDATE executions SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now, row.id);
      return update.changes === 0 ? null : this.getExecution(row.id);
    });
  }

  finishExecution(
    id: string,
    status: "succeeded" | "failed" | "timed_out" | "interrupted",
    error: string | null = null,
  ): Execution | null {
    const result = this.database
      .prepare(`
        UPDATE executions SET status = ?, error = ?, finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `)
      .run(status, error, new Date().toISOString(), id);
    return result.changes === 0 ? null : this.getExecution(id);
  }

  recoverRunningExecutions(): number {
    const now = new Date().toISOString();
    return Number(this.database
      .prepare(`
        UPDATE executions SET
          status = 'interrupted', error = 'Trigger host restarted during execution',
          finished_at = ?
        WHERE status = 'running'
      `)
      .run(now).changes);
  }

  getExecution(id: string): Execution | null {
    const row = this.database
      .prepare("SELECT * FROM executions WHERE id = ?")
      .get(id) as ExecutionRow | undefined;
    return row ? executionFromRow(row) : null;
  }

  listExecutions(options: { triggerId?: string; limit?: number } = {}): Execution[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.triggerId
      ? (this.database
          .prepare(
            "SELECT * FROM executions WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(options.triggerId, limit) as unknown as ExecutionRow[])
      : (this.database
          .prepare("SELECT * FROM executions ORDER BY created_at DESC LIMIT ?")
          .all(limit) as unknown as ExecutionRow[]);
    return rows.map(executionFromRow);
  }

  addLog(input: Omit<ExecutionLog, "id">): ExecutionLog {
    const result = this.database
      .prepare(`
        INSERT INTO execution_logs (
          trigger_id, execution_id, level, values_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.triggerId,
        input.executionId,
        input.level,
        JSON.stringify(input.values),
        input.createdAt,
      );
    const row = this.database
      .prepare("SELECT * FROM execution_logs WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as LogRow;
    return logFromRow(row);
  }

  listLogs(executionId: string): ExecutionLog[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM execution_logs WHERE execution_id = ? ORDER BY id ASC",
        )
        .all(executionId) as unknown as LogRow[]
    ).map(logFromRow);
  }

  addNotification(notification: Notification): void {
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO notifications (
            id, trigger_id, execution_id, output_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          notification.id,
          notification.triggerId,
          notification.executionId,
          JSON.stringify(notification.output),
          notification.status,
          notification.createdAt,
        );
      this.delivery.planJobsForNotification(notification);
    });
  }

  getNotification(id: string): Notification | null {
    const row = this.database
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(id) as NotificationRow | undefined;
    return row ? notificationFromRow(row) : null;
  }

  listNotifications(options: {
    triggerId?: string;
    limit?: number;
  } = {}): Notification[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.triggerId
      ? (this.database
          .prepare(
            "SELECT * FROM notifications WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(options.triggerId, limit) as unknown as NotificationRow[])
      : (this.database
          .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
          .all(limit) as unknown as NotificationRow[]);
    return rows.map(notificationFromRow);
  }

  setServiceState(
    triggerId: string,
    status: ServiceState["status"],
    restartCount: number,
    lastError: string | null,
  ): ServiceState {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO service_states (
          trigger_id, status, restart_count, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(trigger_id) DO UPDATE SET
          status = excluded.status,
          restart_count = excluded.restart_count,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(triggerId, status, restartCount, lastError, now);
    return this.getServiceState(triggerId)!;
  }

  getServiceState(triggerId: string): ServiceState | null {
    const row = this.database
      .prepare("SELECT * FROM service_states WHERE trigger_id = ?")
      .get(triggerId) as ServiceStateRow | undefined;
    return row ? serviceStateFromRow(row) : null;
  }

  listEnabledServices(): Trigger[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM triggers WHERE kind = 'service' AND enabled = 1 ORDER BY created_at ASC",
        )
        .all() as unknown as TriggerRow[]
    ).map(triggerFromRow);
  }

  setSecret(triggerId: string, name: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO trigger_secrets (trigger_id, name, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(trigger_id, name) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(triggerId, name, value, new Date().toISOString());
  }

  deleteSecret(triggerId: string, name: string): boolean {
    return this.database
      .prepare("DELETE FROM trigger_secrets WHERE trigger_id = ? AND name = ?")
      .run(triggerId, name).changes > 0;
  }

  getSecrets(triggerId: string): Record<string, string> {
    const rows = this.database
      .prepare("SELECT name, value FROM trigger_secrets WHERE trigger_id = ?")
      .all(triggerId) as unknown as { name: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.name, row.value]));
  }

  listSecretNames(triggerId: string): string[] {
    return (
      this.database
        .prepare(
          "SELECT name FROM trigger_secrets WHERE trigger_id = ? ORDER BY name ASC",
        )
        .all(triggerId) as unknown as { name: string }[]
    ).map((row) => row.name);
  }

  close(): void {
    this.database.close();
  }
}
