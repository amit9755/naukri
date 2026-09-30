import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { POST } from "../src/app/api/auth/[action]/route.ts";
import { dashboardUser } from "../src/lib/server/control.ts";

const owner = randomUUID();
const credentials = { email: "private-email@example.invalid", password: "private-password" };
const session = { user: { id: owner }, access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600 };
function setup(t: TestContext) {
  const previous = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", SUPABASE_SERVICE_ROLE_KEY: "private-service-role", DASHBOARD_USER_ID: owner, APP_ORIGIN: "https://naukri-gamma.vercel.app" });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => { logs.push(value); });
  t.after(() => assert.doesNotMatch(logs.join("\n"), /private-|example.invalid|sb_publishable|supabase.co|stack/));
  return logs;
}
function invoke(action = "login", payload: unknown = credentials, cookie = "", origin = "https://naukri-gamma.vercel.app") {
  const request = new Request(`https://naukri-gamma.vercel.app/api/auth/${action}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", cookie }, body: JSON.stringify(payload) });
  return POST(request, { params: Promise.resolve({ action }) });
}
async function genericFailure(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: "Authentication unavailable or rejected" });
  assert.equal(response.headers.get("set-cookie"), null);
}
test("login uses publishable apikey, no service bearer, and secure HttpOnly cookies", async (t) => {
  setup(t); delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, "https://project.supabase.co/auth/v1/token?grant_type=password");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("apikey"), "sb_publishable_fixture"); assert.equal(headers.get("Authorization"), null);
    assert.deepEqual(JSON.parse(String(init.body)), credentials); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    return Response.json(session);
  });
  const result = await invoke(); assert.equal(result.status, 200); assert.equal(calls, 1);
  assert.deepEqual(await result.json(), { success: true });
  const cookies = result.headers.getSetCookie(); assert.equal(cookies.length, 2);
  for (const cookie of cookies) { assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=strict/i); assert.match(cookie, /Path=\//i); }
});
test("invalid_credentials gets a fixed server category and generic browser error", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "invalid_credentials", msg: "private-password" }, { status: 400 }));
  await genericFailure(await invoke(), 401);
  assert.deepEqual(JSON.parse(logs[0]), { event: "dashboard-auth-failure", stage: "password", code: "INVALID_CREDENTIALS" });
});
test("missing public key never falls back to service role or calls Auth", async (t) => {
  const logs = setup(t); delete process.env.SUPABASE_PUBLISHABLE_KEY;
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not send credentials"); });
  await genericFailure(await invoke(), 503); assert.match(logs[0], /AUTH_CONFIGURATION_ERROR/);
});
test("secret and legacy service-role keys are rejected in the Auth key slot", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not send credentials"); });
  for (const key of ["sb_secret_private", `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`]) {
    process.env.SUPABASE_PUBLISHABLE_KEY = key;
    await genericFailure(await invoke(), 503);
  }
  assert.equal(logs.length, 2);
});
test("legacy anon key is accepted only as apikey", async (t) => {
  setup(t); process.env.SUPABASE_PUBLISHABLE_KEY = `header.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.signature`;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { assert.equal(new Headers(init.headers).get("Authorization"), null); return Response.json(session); });
  assert.equal((await invoke()).status, 200);
});
test("confirmed Supabase user with different UID receives no session cookies", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...session, user: { id: randomUUID() } }));
  await genericFailure(await invoke(), 403); assert.match(logs[0], /UNAUTHORIZED_DASHBOARD_USER/);
});
test("wrong origin blocks before Auth; malformed config differs from mismatch", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not call Auth"); });
  await genericFailure(await invoke("login", credentials, "", "https://attacker.invalid"), 403); assert.match(logs[0], /ORIGIN_MISMATCH/);
  process.env.APP_ORIGIN = "invalid-origin";
  await genericFailure(await invoke(), 503); assert.match(logs[1], /AUTH_CONFIGURATION_ERROR/);
});
test("invalid owner configuration fails before submitting password", async (t) => {
  const logs = setup(t); process.env.DASHBOARD_USER_ID = "not-a-uuid";
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not call Auth"); });
  await genericFailure(await invoke(), 503); assert.match(logs[0], /AUTH_CONFIGURATION_ERROR/);
});
test("provider key rejection, throttling and network errors are distinguished without raw logs", async (t) => {
  const logs = setup(t);
  const responses = [Response.json({ message: "private-service-role" }, { status: 401 }), Response.json({}, { status: 429 })];
  t.mock.method(globalThis, "fetch", async () => { if (responses.length) return responses.shift()!; throw new Error("private-password private-access-token"); });
  await genericFailure(await invoke(), 503); await genericFailure(await invoke(), 429); await genericFailure(await invoke(), 503);
  assert.deepEqual(logs.map((log) => JSON.parse(log).code), ["AUTH_CONFIGURATION_ERROR", "AUTH_RATE_LIMITED", "AUTH_UNAVAILABLE"]);
});
test("malformed successful session never creates partial cookies", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...session, refresh_token: undefined }));
  await genericFailure(await invoke(), 502); assert.match(logs[0], /SESSION_ERROR/);
});
test("refresh exchanges HttpOnly refresh token, validates owner, and rotates cookies", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /grant_type=refresh_token$/); assert.deepEqual(JSON.parse(String(init.body)), { refresh_token: "private-refresh-token" });
    assert.equal(new Headers(init.headers).get("Authorization"), null); return Response.json(session);
  });
  const response = await invoke("session", {}, "naukri_refresh=private-refresh-token");
  assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2);
});
test("expired refresh is SESSION_ERROR; absent cookie is a quiet unauthenticated state", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "refresh_token_not_found" }, { status: 400 }));
  await genericFailure(await invoke("session", {}, "naukri_refresh=private-refresh-token"), 401);
  assert.match(logs[0], /SESSION_ERROR/);
  await genericFailure(await invoke("session", {}), 401); assert.equal(logs.length, 1);
});
test("dashboard user verification uses user JWT plus public apikey and rejects wrong owner", async (t) => {
  const logs = setup(t); let allowed = true;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /\/auth\/v1\/user$/); const headers = new Headers(init.headers);
    assert.equal(headers.get("apikey"), "sb_publishable_fixture"); assert.equal(headers.get("Authorization"), "Bearer private-access-token");
    return Response.json({ id: allowed ? owner : randomUUID() });
  });
  const request = new Request("https://naukri-gamma.vercel.app/dashboard", { headers: { cookie: "naukri_access=private-access-token" } });
  assert.equal(await dashboardUser(request), owner); allowed = false;
  await assert.rejects(dashboardUser(request), /FORBIDDEN/); assert.match(logs[0], /UNAUTHORIZED_DASHBOARD_USER/);
});
test("logout revokes user session and clears cookies even if provider fails", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /\/logout$/); assert.equal(new Headers(init.headers).get("Authorization"), "Bearer private-access-token"); throw new Error("private-access-token");
  });
  const response = await invoke("logout", {}, "naukri_access=private-access-token");
  assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2); assert.match(logs[0], /AUTH_UNAVAILABLE/);
});
test("unexpected login body keys fail with sanitized INVALID_REQUEST before Auth", async (t) => {
  const logs = setup(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not call Auth"); });
  await genericFailure(await invoke("login", { ...credentials, injected: "private-value" }), 400);
  assert.match(logs[0], /INVALID_REQUEST/);
});
