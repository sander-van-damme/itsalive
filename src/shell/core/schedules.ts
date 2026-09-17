import { ShellDatabase } from "./database";
import type { ScheduleRecord } from "./types";

export class ScheduleCache {
  constructor(private readonly db: ShellDatabase) {}
  async register(appSlug: string, callbackId: string, expression: string, nextRun?: number): Promise<ScheduleRecord> {
    if (!callbackId.trim() || !expression.trim()) throw new Error("Schedule callback ID and expression are required");
    const id = `${appSlug}:${callbackId}`;
    const previous = await this.db.get<ScheduleRecord>("schedules", id);
    const record = { id, appSlug, expression, nextRun, registeredAt: Date.now(), lastFired: previous?.lastFired };
    await this.db.schedules.put(record);
    return record;
  }
  async due(now = Date.now()): Promise<ScheduleRecord[]> {
    return (await this.db.schedules.list()).filter(x => x.nextRun != null && x.nextRun <= now).sort((a, b) => a.nextRun! - b.nextRun!);
  }
  async markFired(id: string, nextRun?: number): Promise<void> {
    const record = await this.db.get<ScheduleRecord>("schedules", id);
    if (!record) return;
    await this.db.schedules.put({ ...record, lastFired: Date.now(), nextRun });
  }
}

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

/** Returns the next minute matching a conventional five-field UTC cron expression. */
export function nextCronRun(expression: string, after = Date.now()): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must contain minute, hour, day, month, and weekday fields");
  const accepted = fields.map((field, index) => {
    const bounds = FIELDS[index]!;
    return expandCronField(field!, bounds[0], bounds[1]);
  });
  const candidate = new Date(after); candidate.setUTCSeconds(0, 0); candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60_000;
  for (; candidate.getTime() <= limit; candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)) {
    const values = [candidate.getUTCMinutes(), candidate.getUTCHours(), candidate.getUTCDate(), candidate.getUTCMonth() + 1, candidate.getUTCDay()];
    if (values.every((value, index) => accepted[index]!.has(value))) return candidate.getTime();
  }
  throw new Error("Cron expression has no matching time in the next year");
}

function expandCronField(source: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of source.split(',')) {
    const [base = '', rawStep] = part.split('/');
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let start: number; let end: number;
    if (base === '*') { start = min; end = max; }
    else if (base.includes('-')) { const range = base.split('-').map(Number); start = range[0]!; end = range[1]!; }
    else { start = Number(base); end = start; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error(`Invalid cron field: ${part}`);
    for (let value = start; value <= end; value += step) result.add(value);
  }
  return result;
}
