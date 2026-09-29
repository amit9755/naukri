import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("migration enforces registration, atomic claims, daily uniqueness, completion and RLS", async () => {
  const db = new PGlite();
  await db.exec("create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../supabase/migrations/202609290001_agent_control.sql", import.meta.url), "utf8"));
  for (const [local, zone, expected] of [
    ["2026-11-01 01:30", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-03-08 02:30", "America/New_York", "2026-03-08T07:30:00.000Z"],
    ["2026-04-05 01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
  ]) {
    const actual = (await db.query<{ target: Date }>("select schedule_instant($1,$2) as target", [local, zone])).rows[0].target;
    assert.equal(actual.toISOString(), expected);
  }
  const owner = randomUUID(), agent = randomUUID(), key = randomUUID();
  await db.query("insert into auth.users values($1)", [owner]);
  await db.query("select register_agent($1,$2,$3,'Laptop',$4,'1.0.0')", [agent, owner, randomUUID(), "a".repeat(64)]);
  const config = (await db.query<{ enabled: boolean; timezone: string }>("select * from automation_config")).rows[0];
  assert.equal(config.enabled, false); assert.equal(config.timezone, "Asia/Kolkata");
  const manual = await db.query<{ id: string }>("select * from enqueue_refresh($1)", [agent]);
  await assert.rejects(db.query("select enqueue_refresh($1)", [agent]), /one_active_refresh/);
  const claims = await Promise.all([db.query<{ id: string }>("select * from claim_refresh($1,$2,null)", [agent, key]), db.query<{ id: string }>("select * from claim_refresh($1,$2,null)", [agent, randomUUID()])]);
  assert.equal(claims[0].rows.length + claims[1].rows.length, 1);
  const replay = await db.query<{ id: string }>("select * from claim_refresh($1,$2,null)", [agent, key]);
  assert.equal(replay.rows[0].id, manual.rows[0].id);
  assert.equal((await db.query("select * from automation_runs")).rows.length, 1);
  const result = { success: true, mode: "same-name-save", saveAttempted: true, originalNamePreserved: true, verifiedAfterReload: true, refreshTimestampVerified: false };
  await db.query("select complete_refresh($1,$2,'SUCCESS',$3,null)", [agent, manual.rows[0].id, JSON.stringify(result)]);
  await db.query("select complete_refresh($1,$2,'FAILED','{}','REFRESH_FAILED')", [agent, manual.rows[0].id]);
  assert.equal((await db.query<{ status: string }>("select status from automation_commands")).rows[0].status, "SUCCESS");
  await db.query("update automation_config set enabled=true,schedule_time='00:00',catch_up=true where agent_id=$1", [agent]);
  const day = (await db.query<{ day: string }>("select ((now() at time zone 'Asia/Kolkata')::date)::text as day")).rows[0].day;
  const scheduled = await db.query<{ id: string; source: string }>("select * from claim_refresh($1,$2,$3)", [agent, randomUUID(), day]);
  assert.equal(scheduled.rows[0].source, "SCHEDULED");
  await db.query("select complete_refresh($1,$2,'AUTH_REQUIRED','{}','AUTH_REQUIRED')", [agent, scheduled.rows[0].id]);
  assert.equal((await db.query("select * from claim_refresh($1,$2,$3)", [agent, randomUUID(), day])).rows.length, 0);
  assert.equal((await db.query<{ day: string }>("select last_scheduled_date::text as day from automation_config")).rows[0].day, day);
  const stale = await db.query<{ id: string }>("select * from enqueue_refresh($1)", [agent]);
  await db.query("select * from claim_refresh($1,$2,null)", [agent, randomUUID()]);
  await db.query("update automation_commands set claimed_at=now()-interval '31 minutes' where id=$1", [stale.rows[0].id]);
  await db.query("select reconcile_stale($1)", [agent]);
  assert.equal((await db.query<{ status: string }>("select status from automation_commands where id=$1", [stale.rows[0].id])).rows[0].status, "FAILED");
  assert.equal((await db.query<{ enabled: boolean }>("select enabled from automation_config")).rows[0].enabled, false);
  await db.exec("set role authenticated");
  await assert.rejects(db.query("select * from agents"), /permission denied/);
  await assert.rejects(db.query("select * from claim_refresh($1,$2,null)", [agent, randomUUID()]), /permission denied/);
  await db.close();
});
