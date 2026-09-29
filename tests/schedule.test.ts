import assert from "node:assert/strict";
import { test } from "node:test";
import { dueDate, nextRun, validSchedule } from "../lib/automation/schedule.ts";
import { online } from "../lib/automation/contracts.ts";
const config = { agent_id: "fixture", enabled: true, schedule_time: "06:30", timezone: "Asia/Kolkata", catch_up: true, last_scheduled_date: null };
test("06:30 IST is 01:00 UTC; before schedule does not run", () => {
  assert.equal(dueDate(config, "2026-09-29T00:59:59Z"), null);
  assert.equal(nextRun(config, "2026-09-29T00:59:59Z"), "2026-09-29T01:00:00Z");
  assert.equal(dueDate(config, "2026-09-29T01:00:00Z"), "2026-09-29");
});
test("restart and catch-up are once per local calendar day", () => {
  assert.equal(dueDate(config, "2026-09-29T16:00:00Z"), "2026-09-29");
  const ran = { ...config, last_scheduled_date: "2026-09-29" };
  assert.equal(dueDate(ran, "2026-09-29T16:00:00Z"), null);
  assert.equal(nextRun(ran, "2026-09-29T16:00:00Z"), "2026-09-30T01:00:00Z");
});
test("disabled schedule and disabled catch-up", () => {
  assert.equal(dueDate({ ...config, enabled: false }, "2026-09-29T16:00:00Z"), null);
  assert.equal(nextRun({ ...config, enabled: false }), null);
  assert.equal(dueDate({ ...config, catch_up: false }, "2026-09-29T01:00:30Z"), "2026-09-29");
  assert.equal(dueDate({ ...config, catch_up: false }, "2026-09-29T01:01:00Z"), null);
});
test("timezone conversion handles DST and local date boundaries", () => {
  const ny = { ...config, timezone: "America/New_York", schedule_time: "02:30" };
  assert.equal(nextRun(ny, "2026-03-08T05:00:00Z"), "2026-03-08T07:30:00Z");
  assert.equal(dueDate(config, "2026-09-29T23:30:00Z"), null); // Sep 30, 05:00 IST
  assert.equal(validSchedule("25:00", "Asia/Kolkata"), false);
  assert.equal(validSchedule("06:30", "Not/AZone"), false);
});
test("heartbeat online/offline is independent of schedule state", () => {
  assert.equal(online("2026-09-29T01:00:00Z", Date.parse("2026-09-29T01:01:00Z")), true);
  assert.equal(online("2026-09-29T01:00:00Z", Date.parse("2026-09-29T01:03:00Z")), false);
  assert.equal(online(null), false);
});
