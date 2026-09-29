import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ApiError, agentUser, bearer, dashboardUser, defaultControlDependencies, equalSecret, handleControl, originCheck, secretHash } from "../src/lib/server/control.ts";
import { readFile } from "node:fs/promises";
const owner = randomUUID(), agent = randomUUID();
function request(path: string, value: unknown = {}, method = "POST") {
  return new Request(`https://dashboard.example/api/${path}`, { method, headers: { "Content-Type": "application/json", Origin: "https://dashboard.example" }, ...(method === "GET" ? {} : { body: JSON.stringify(value) }) });
}
function dependencies(db: typeof defaultControlDependencies.db = async () => [{ id: agent }]) {
  return { db, dashboardUser: async () => owner, agentUser: async () => agent, originCheck: () => {} };
}
test("dashboard and agent routes reject unauthenticated access", async () => {
  const deps = dependencies(); deps.dashboardUser = async () => { throw new ApiError(401, "UNAUTHORIZED"); }; deps.agentUser = deps.dashboardUser;
  assert.equal((await handleControl(request("dashboard/status", {}, "GET"), "dashboard/status", deps)).status, 401);
  assert.equal((await handleControl(request("agent/commands/claim"), "agent/commands/claim", deps)).status, 401);
});
test("Run Now authorizes owner and queues one allowlisted command", async () => {
  const writes: string[] = [];
  const deps = dependencies(async (path, init) => {
    if (path.startsWith("/rest/v1/agents?")) { assert.ok(path.includes(`owner_id=eq.${owner}`)); return [{ id: agent }]; }
    writes.push(path); assert.deepEqual(JSON.parse(String(init?.body)), { p_agent: agent }); return { id: randomUUID(), status: "PENDING" };
  });
  assert.equal((await handleControl(request("automation/run", { agent_id: agent }), "automation/run", deps)).status, 202);
  assert.deepEqual(writes, ["/rest/v1/rpc/enqueue_refresh"]);
  assert.equal((await handleControl(request("automation/run", { agent_id: agent, command: "exec" }), "automation/run", deps)).status, 400);
  assert.equal((await handleControl(request("automation/run", { agent_id: agent }), "automation/run", dependencies(async () => []))).status, 403);
});
test("duplicate Run Now is a conflict; no retry is performed", async () => {
  let attempts = 0;
  const deps = dependencies(async (path) => { if (path.includes("rpc")) { attempts++; throw new ApiError(409, "ACTIVE_COMMAND_EXISTS"); } return [{ id: agent }]; });
  assert.equal((await handleControl(request("automation/run", { agent_id: agent }), "automation/run", deps)).status, 409);
  assert.equal(attempts, 1);
});
test("schedule validation, config update, malformed and oversized bodies", async () => {
  const config = { agent_id: agent, enabled: true, schedule_time: "06:30", timezone: "Asia/Kolkata", catch_up: true };
  let patched = false;
  const deps = dependencies(async (_path, init) => { if (init?.method === "PATCH") patched = true; return [{ id: agent }]; });
  assert.equal((await handleControl(request("automation/config", config, "PUT"), "automation/config", deps)).status, 200); assert.equal(patched, true);
  assert.equal((await handleControl(request("automation/config", { ...config, schedule_time: "99:00" }, "PUT"), "automation/config", deps)).status, 400);
  assert.equal((await handleControl(request("automation/config", { ...config, timezone: "secret" }, "PUT"), "automation/config", deps)).status, 400);
  assert.equal((await handleControl(request("automation/run", { agent_id: agent, value: "x".repeat(17000) }), "automation/run", deps)).status, 413);
});
test("claim RPC and completion use only authenticated agent identity and sanitized result", async () => {
  const calls: Record<string, unknown>[] = [];
  const deps = dependencies(async (path, init) => { const args = JSON.parse(String(init?.body)); calls.push(args); return path.includes("claim_refresh") ? [] : true; });
  assert.equal((await handleControl(request("agent/commands/claim", { claimKey: randomUUID(), scheduledDate: null }), "agent/commands/claim", deps)).status, 200);
  const id = randomUUID();
  const done = { status: "AUTH_REQUIRED", error_code: "AUTH_REQUIRED", result: { success: false, password: "private-password", cookies: "private-cookie" } };
  assert.equal((await handleControl(request(`agent/commands/${id}/complete`, done), `agent/commands/${id}/complete`, deps)).status, 200);
  assert.equal(calls.at(-1)?.p_agent, agent);
  assert.doesNotMatch(JSON.stringify(calls), /private-password|private-cookie|cookies/);
});
test("dashboard status strips secrets and computes online/next-run", async () => {
  const deps = dependencies(async (path) => {
    if (path.includes("rpc")) return 0;
    if (path.startsWith("/rest/v1/agents")) return [{ id: agent, name: "Laptop", secret_hash: "private-key", last_seen_at: new Date().toISOString(), session_status: "AUTH_REQUIRED" }];
    if (path.includes("automation_config")) return [{ agent_id: agent, enabled: true, schedule_time: "06:30", timezone: "Asia/Kolkata", catch_up: true, last_scheduled_date: null }];
    if (path.includes("automation_runs")) return [{ id: randomUUID(), status: "SUCCESS", source: "MANUAL", started_at: new Date().toISOString(), result: { success: true, password: "private-password" } }];
    return [];
  });
  const response = await handleControl(request("dashboard/status", {}, "GET"), "dashboard/status", deps);
  const text = await response.text(); assert.doesNotMatch(text, /private-key|private-password|secret_hash/);
  assert.equal(JSON.parse(text).agents[0].online, true); assert.ok(JSON.parse(text).agents[0].nextRun);
});
test("real authentication helpers validate Supabase user, agent secret and CSRF origin", async (t) => {
  process.env.SUPABASE_URL = "https://supabase.example"; process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-role-key";
  process.env.DASHBOARD_USER_ID = owner; process.env.APP_ORIGIN = "https://dashboard.example";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    return String(input).includes("/auth/v1/user") ? Response.json({ id: owner }) : Response.json([{ id: agent, secret_hash: secretHash("s".repeat(43)) }]);
  });
  assert.equal(await dashboardUser(new Request("https://dashboard.example", { headers: { cookie: "naukri_access=fixture-access" } })), owner);
  assert.equal(await agentUser(new Request("https://dashboard.example", { headers: { "x-agent-id": agent, Authorization: `Bearer ${"s".repeat(43)}` } })), agent);
  await assert.rejects(agentUser(new Request("https://dashboard.example", { headers: { "x-agent-id": agent, Authorization: `Bearer ${"t".repeat(43)}` } })));
  assert.throws(() => bearer(request("agent/heartbeat")));
  assert.equal(equalSecret("a", "b"), false);
  assert.throws(() => originCheck(new Request("https://dashboard.example", { headers: { Origin: "https://attacker.example" } })));
});
test("Vercel routes have no Playwright execution imports; refresh save workflow retained", async () => {
  for (const file of ["src/app/api/test-browser/route.ts", "src/app/api/test-naukri/route.ts", "src/lib/server/control.ts"]) {
    assert.doesNotMatch(await readFile(new URL(`../${file}`, import.meta.url), "utf8"), /from ["']playwright|launchPersistentContext|\.launch\(/);
  }
  const refresh = await readFile(new URL("../scripts/refresh-naukri-name.ts", import.meta.url), "utf8");
  assert.equal((refresh.match(/await save\.click\(\)/g) ?? []).length, 1);
  assert.match(refresh, /refreshTimestampVerified: false/);
});

test("registration requires enrollment authorization and stores only a hash", async () => {
  process.env.AGENT_ENROLLMENT_SECRET = "e".repeat(64); process.env.DASHBOARD_USER_ID = owner;
  let calls = 0;
  const deps = dependencies(async (_path, init) => {
    calls++;
    const args = JSON.parse(String(init?.body));
    assert.equal(args.p_hash, secretHash("s".repeat(43)));
    assert.equal(args.p_owner, owner); assert.doesNotMatch(String(init?.body), /ssssssssssss/);
    return agent;
  });
  const payload = { id: agent, machine_id: randomUUID(), name: "Windows laptop", secret: "s".repeat(43), app_version: "1.0.0" };
  assert.equal((await handleControl(request("agent/register", payload), "agent/register", deps)).status, 401);
  const req = request("agent/register", payload); req.headers.set("Authorization", `Bearer ${"e".repeat(64)}`);
  const response = await handleControl(req, "agent/register", deps);
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.doesNotMatch(await response.text(), /secret|ssssssss/);
});
test("heartbeat writes authenticated identity and service failures remain sanitized", async () => {
  let heartbeat = false;
  const deps = dependencies(async (path, init) => {
    if (init?.method === "PATCH") {
      heartbeat = true; assert.ok(path.includes(agent));
      assert.equal(JSON.parse(String(init.body)).status, "ONLINE"); return null;
    }
    return [{ agent_id: agent, enabled: false }];
  });
  const response = await handleControl(request("agent/heartbeat", { app_version: "1.0.0" }), "agent/heartbeat", deps);
  assert.equal(response.status, 200); assert.equal(heartbeat, true);
  assert.equal((await response.json()).config.agent_id, agent);
  deps.db = async () => { throw new Error("private-authorization-token"); };
  const failed = await handleControl(request("agent/heartbeat", { app_version: "1.0.0" }), "agent/heartbeat", deps);
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-authorization-token/);
});
test("invalid calendar dates and contradictory successful completions stop before RPC", async () => {
  let calls = 0; const deps = dependencies(async () => { calls++; return []; });
  assert.equal((await handleControl(request("agent/commands/claim", { claimKey: randomUUID(), scheduledDate: "2026-02-31" }), "agent/commands/claim", deps)).status, 400);
  const path = `agent/commands/${randomUUID()}/complete`;
  assert.equal((await handleControl(request(path, { status: "SUCCESS", error_code: null, result: { success: true, saveAttempted: false } }), path, deps)).status, 400);
  assert.equal(calls, 0);
});
