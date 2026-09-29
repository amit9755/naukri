import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, loadIdentity, localLog, serverOrigin } from "../scripts/agent/storage.ts";
import type { Journal } from "../scripts/agent/storage.ts";
import { AgentClient, backoff } from "../scripts/agent/client.ts";
import { AgentWorker } from "../scripts/agent/worker.ts";
import { parseRefreshOutput } from "../scripts/agent/executor.ts";
import { failed } from "../lib/automation/contracts.ts";

test("random agent identity persists, origin binds, singleton lock excludes overlap and logs redact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "naukri-agent-test-"));
  try {
    const a = await loadIdentity(dir, "https://dashboard.example");
    assert.deepEqual(await loadIdentity(dir, "https://dashboard.example"), a);
    assert.equal(a.secret.length, 43); assert.notEqual(a.id, a.machine_id);
    await assert.rejects(loadIdentity(dir, "https://attacker.example"));
    assert.throws(() => serverOrigin("http://example.com"));
    const release = await acquireAgentLock(dir); await assert.rejects(acquireAgentLock(dir)); await release();
    await localLog(dir, "run-finished", { status: a.secret, commandId: "cookie-secret", source: "credential-value", errorCode: "private-password", result: { success: false, cookies: "private-cookie", password: "private-password" } });
    await localLog(dir, "credential-value");
    const log = await readFile(join(dir, "logs", "agent.log"), "utf8");
    assert.doesNotMatch(log, /cookie-secret|credential-value|private-cookie|private-password/); assert.ok(!log.includes(a.secret));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("agent requests use header authentication, HTTPS origin, timeout and sanitized network errors", async () => {
  const identity = { id: randomUUID(), machine_id: randomUUID(), secret: "s".repeat(43), server: "https://dashboard.example", registered: true };
  let calls = 0;
  const client = new AgentClient(identity, async (url, init) => {
    calls++; assert.ok(!String(url).includes(identity.secret));
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${identity.secret}`);
    assert.ok(init?.signal);
    return Response.json({ config: { enabled: false } });
  });
  assert.equal((await client.request("heartbeat", { app_version: "1.0.0" })).config.enabled, false);
  assert.equal(calls, 1);
  const broken = new AgentClient(identity, async () => { throw new Error("private network token"); });
  await assert.rejects(broken.request("heartbeat", {}), /^Error: AGENT_NETWORK_FAILED$/);
  assert.equal(backoff(10), 300_000);
});
function workerFixture() {
  let journal: Journal | null = null, saves = 0, completes = 0, failComplete = false;
  const agent = randomUUID(), command = randomUUID();
  const config = { agent_id: agent, enabled: true, schedule_time: "06:30", timezone: "Asia/Kolkata", catch_up: true, last_scheduled_date: null };
  const worker = new AgentWorker({
    read: async () => journal, write: async (value) => { journal = value; }, log: async () => {},
    request: async (path, raw) => {
      if (path === "commands/claim") return { command: { id: command, agent_id: agent, command: "RUN_REFRESH", status: "RUNNING", source: "MANUAL", claim_key: (raw as { claimKey: string }).claimKey } };
      completes++; if (failComplete) throw new Error("network"); return { completed: true };
    },
    execute: async () => { saves++; assert.equal(journal?.phase, "started"); return failed("AUTH_REQUIRED"); },
  });
  return { worker, config, saves: () => saves, completes: () => completes, journal: () => journal, setJournal: (value: Journal) => { journal = value; }, setFail: () => { failComplete = true; } };
}
test("worker single-flight prevents overlapping refresh and reports AUTH_REQUIRED", async () => {
  const f = workerFixture(); await Promise.all([f.worker.tick(f.config), f.worker.tick(f.config)]);
  assert.equal(f.saves(), 1); assert.equal(f.completes(), 1); assert.equal(f.journal(), null);
});
test("network completion failure replays reporting only, never a browser save", async () => {
  const f = workerFixture(); f.setFail();
  await assert.rejects(f.worker.tick(f.config)); await assert.rejects(f.worker.tick(f.config));
  assert.equal(f.saves(), 1); assert.equal(f.journal()?.phase, "completed");
});
test("restart during RUNNING reports uncertainty without executing again", async () => {
  const f = workerFixture(); f.setJournal({ claimKey: randomUUID(), scheduledDate: null, phase: "started", command: { id: randomUUID(), agent_id: f.config.agent_id, claim_key: randomUUID(), command: "RUN_REFRESH", source: "MANUAL", status: "RUNNING" } });
  await f.worker.tick(f.config); assert.equal(f.saves(), 0); assert.equal(f.completes(), 1);
});
test("arbitrary remote command is rejected before execution", async () => {
  const f = workerFixture(); f.worker.deps.request = async () => ({ command: { id: randomUUID(), command: "powershell", status: "RUNNING" } });
  await assert.rejects(f.worker.tick(f.config)); assert.equal(f.saves(), 0);
});
test("refresh parser allowlists results; unverified timestamp alone is not failure", () => {
  const good = { success: true, mode: "same-name-save", saveAttempted: true, originalNamePreserved: true, verifiedAfterReload: true, refreshTimestampVerified: false, password: "secret", cookies: "secret" };
  const result = parseRefreshOutput([JSON.stringify(good)], 0);
  assert.equal(result.status, "SUCCESS"); assert.doesNotMatch(JSON.stringify(result), /secret|password|cookies/);
  assert.equal(parseRefreshOutput([JSON.stringify({ success: false, errorCode: "AUTH_REQUIRED" })], 1).status, "AUTH_REQUIRED");
  assert.equal(parseRefreshOutput([], 1).status, "FAILED");
});

test("lost claim response preserves claim key across restart before execution", async () => {
  const f = workerFixture(); const original = f.worker.deps.request;
  let key: unknown;
  f.worker.deps.request = async (_path, body) => { key = (body as { claimKey: string }).claimKey; throw new Error("network"); };
  await assert.rejects(f.worker.tick(f.config));
  assert.equal(f.journal()?.phase, "claiming"); assert.equal(f.saves(), 0);
  const recovered = new AgentWorker({ ...f.worker.deps, request: async (path, body) => {
    if (path === "commands/claim") assert.equal((body as { claimKey: string }).claimKey, key);
    return original(path, body);
  } });
  await recovered.tick(f.config); assert.equal(f.saves(), 1); assert.equal(f.completes(), 1);
});
