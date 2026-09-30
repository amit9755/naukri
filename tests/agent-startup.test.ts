import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AgentClient } from "../scripts/agent/client.ts";
import { RegistrationFailure, startupDiagnostic } from "../scripts/agent/startup-diagnostics.ts";
import type { StartupStage } from "../scripts/agent/startup-diagnostics.ts";

const identity = { id: randomUUID(), machine_id: randomUUID(), secret: "s".repeat(43), server: "https://dashboard.example", registered: false };
const enrollment = "e".repeat(64);
const privateData = JSON.stringify({ agentId: identity.id, machineId: identity.machine_id, secret: identity.secret, enrollment, password: "private-password", email: "private-email", cookie: "private-cookie", authorization: "Bearer private-token", supabase: "private-key" });
async function diagnostic(transport: typeof fetch) {
  let calls = 0;
  const client = new AgentClient(identity, async (...args) => { calls++; return transport(...args); });
  try { await client.request("register", { ...identity }, enrollment); assert.fail("expected failure"); }
  catch (error) {
    const result = startupDiagnostic(error, "registration");
    assert.equal(calls, 1);
    const output = JSON.stringify(result);
    for (const secret of [identity.id, identity.machine_id, identity.secret, enrollment, "private-", "Authorization", "stack"]) assert.ok(!output.includes(secret));
    assert.equal(identity.registered, false);
    return result;
  }
}
test("registration HTTP failures expose only category and numeric status; bodies are never read", async () => {
  const categories: Record<number, string> = { 400: "REGISTRATION_UNKNOWN_ERROR", 401: "REGISTRATION_UNAUTHORIZED", 403: "REGISTRATION_FORBIDDEN", 404: "REGISTRATION_NOT_FOUND", 409: "REGISTRATION_CONFLICT", 429: "REGISTRATION_RATE_LIMITED", 500: "REGISTRATION_SERVER_ERROR", 503: "REGISTRATION_SERVER_ERROR" };
  for (const [status, category] of Object.entries(categories)) {
    const result = await diagnostic(async () => {
      const response = new Response(privateData, { status: Number(status) });
      response.json = async () => { assert.fail("HTTP error body must not be read"); };
      response.text = async () => { assert.fail("HTTP error body must not be read"); };
      return response;
    });
    assert.deepEqual(result, { success: false, error: category, httpStatus: Number(status) });
  }
});
test("registration fetch and timeout errors never expose arbitrary messages or causes", async () => {
  for (const error of [new Error(privateData), new DOMException(privateData, "TimeoutError"), { message: privateData, cause: privateData }]) {
    assert.deepEqual(await diagnostic(async () => { throw error; }), { success: false, error: "REGISTRATION_NETWORK_ERROR" });
  }
});
test("HTML and malformed JSON registration responses are sanitized", async () => {
  for (const body of [privateData + "invalid json", `<html>${privateData}</html>`, ""]) {
    assert.deepEqual(await diagnostic(async () => new Response(body, { status: 200 })), { success: false, error: "REGISTRATION_INVALID_RESPONSE", httpStatus: 200 });
  }
});
test("unexpected registration success shapes and mismatched identity stop safely", async () => {
  for (const body of [null, [], {}, { registered: false }, { registered: true, agentId: randomUUID(), message: privateData }]) {
    assert.deepEqual(await diagnostic(async () => Response.json(body)), { success: false, error: "REGISTRATION_INVALID_RESPONSE", httpStatus: 200 });
  }
});
test("valid registration preserves endpoint, secret headers, single request and success result", async () => {
  let calls = 0;
  const expected = { registered: true, agentId: identity.id };
  const client = new AgentClient(identity, async (url, init) => {
    calls++; assert.equal(url, "https://dashboard.example/api/agent/register");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${enrollment}`);
    assert.equal(new Headers(init?.headers).get("X-Agent-ID"), identity.id);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    return Response.json(expected);
  });
  assert.deepEqual(await client.request("register", {}, enrollment), expected); assert.equal(calls, 1);
});
test("local failures expose stage category only, never exception messages or IDs", () => {
  const categories: Record<StartupStage, string> = { local: "LOCAL_SETUP_ERROR", origin: "INVALID_SERVER_ORIGIN", identity: "IDENTITY_ERROR", enrollment: "ENROLLMENT_REQUIRED", registration: "REGISTRATION_UNKNOWN_ERROR", running: "AGENT_STOPPED_CHECK_LOCAL_SETUP" };
  for (const [stage, category] of Object.entries(categories)) {
    assert.deepEqual(startupDiagnostic(new Error(privateData), stage as StartupStage), { success: false, error: category });
  }
  assert.deepEqual(startupDiagnostic({ category: privateData, httpStatus: 401 }, "registration"), { success: false, error: "REGISTRATION_UNKNOWN_ERROR" });
});
test("diagnostic projection rejects mutated categories/status and excludes extra exception fields", () => {
  const error = new RegistrationFailure("REGISTRATION_UNAUTHORIZED", 401);
  Object.assign(error, { category: privateData, httpStatus: privateData, body: privateData, headers: privateData });
  assert.deepEqual(startupDiagnostic(error, "registration"), { success: false, error: "REGISTRATION_UNKNOWN_ERROR" });
  for (const status of [NaN, Infinity, -1, 600, 401.5]) {
    assert.deepEqual(startupDiagnostic(new RegistrationFailure("REGISTRATION_UNKNOWN_ERROR", status), "registration"), { success: false, error: "REGISTRATION_UNKNOWN_ERROR" });
  }
});
