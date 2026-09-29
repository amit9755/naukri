import { Temporal } from "@js-temporal/polyfill";
import type { Config } from "./contracts.ts";

export function validSchedule(time: unknown, zone: unknown) {
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || typeof zone !== "string" || zone.length > 80 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+)$/.test(zone)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return true; } catch { return false; }
}
export function validScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}
function today(config: Config, now: string) {
  const current = Temporal.Instant.from(now).toZonedDateTimeISO(config.timezone);
  const date = current.toPlainDate();
  const target = date.toZonedDateTime({ timeZone: config.timezone, plainTime: Temporal.PlainTime.from(config.schedule_time) });
  return { current, date, target };
}
export function dueDate(config: Config, now = new Date().toISOString()): string | null {
  if (!config.enabled) return null;
  const { current, date, target } = today(config, now);
  const dateKey = date.toString();
  if (config.last_scheduled_date && config.last_scheduled_date >= dateKey) return null;
  const elapsed = current.epochMilliseconds - target.epochMilliseconds;
  return elapsed >= 0 && (config.catch_up || elapsed < 60_000) ? dateKey : null;
}
export function nextRun(config: Config, now = new Date().toISOString()): string | null {
  if (!config.enabled) return null;
  const { current, date, target } = today(config, now);
  if (config.last_scheduled_date !== date.toString() && current.epochMilliseconds < target.epochMilliseconds) return target.toInstant().toString();
  if (dueDate(config, now)) return current.toInstant().toString();
  return date.add({ days: 1 }).toZonedDateTime({ timeZone: config.timezone, plainTime: Temporal.PlainTime.from(config.schedule_time) }).toInstant().toString();
}
