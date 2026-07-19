import { Cron } from "croner";

import type {
  JsonValue,
  ScheduleInput,
  TriggerSchedule,
} from "../domain/types.js";
import { asJsonValue } from "../domain/validation.js";
import type { TriggerDatabase } from "../persistence/database.js";
import type { ExecutionQueue } from "./execution-queue.js";

export function nextScheduleRun(
  schedule: Pick<ScheduleInput, "kind" | "expression" | "timezone">,
  after = new Date(),
): string | null {
  if (schedule.kind === "once") {
    return new Date(schedule.expression).toISOString();
  }
  const cron = new Cron(schedule.expression, {
    paused: true,
    timezone: schedule.timezone,
  });
  try {
    return cron.nextRun(after)?.toISOString() ?? null;
  } finally {
    cron.stop();
  }
}

export class TriggerScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly database: TriggerDatabase,
    private readonly queue: ExecutionQueue,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let queued = 0;
    try {
      const due = this.database.listDueSchedules(now.toISOString());
      for (const schedule of due) {
        if (this.enqueue(schedule, now)) queued += 1;
      }
      if (queued > 0) this.queue.wake();
      return queued;
    } finally {
      this.ticking = false;
    }
  }

  private enqueue(schedule: TriggerSchedule, now: Date): boolean {
    if (!schedule.nextRunAt) return false;
    const trigger = this.database.getTrigger(schedule.triggerId);
    if (!trigger?.enabled || trigger.kind !== "schedule") return false;
    const nextRunAt =
      schedule.kind === "once"
        ? null
        : nextScheduleRun(schedule, new Date(Math.max(now.getTime(), new Date(schedule.nextRunAt).getTime())));
    const event = asJsonValue({
      type: "schedule",
      scheduleId: schedule.id,
      scheduledFor: schedule.nextRunAt,
    }) as JsonValue;
    return Boolean(
      this.database.enqueueScheduledExecution({
        scheduleId: schedule.id,
        expectedRunAt: schedule.nextRunAt,
        nextRunAt,
        executionId: crypto.randomUUID(),
        triggerId: trigger.id,
        revisionId: trigger.activeRevisionId,
        event,
      }),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
