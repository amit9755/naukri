import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { handleControl } from "../src/lib/server/control.ts";

const path = "dashboard/enrollment-diagnostic";
const owner = "11111111-1111-4111-8111-111111111111";
function setup(t: TestContext) {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, { SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", DASHBOARD_USER_ID: owner });
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(JSON.stringify(args)); });
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(JSON.stringify(args)); });
  return logs;
}
function request(authenticated = true) {
  return new Request(`https://dashboard.example/api/${path}`, { headers: authenticated ? { cookie: "naukri_access=fixture-access-token" } : {} });
}
test("enrollment diagnostic rejects absent session and a different authenticated dashboard user", async (t) => {
  setup(t); process.env.AGENT_ENROLLMENT_SECRET = "private-enrollment-value";
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: "22222222-2222-4222-8222-222222222222" }));
  for (const [authenticated, status] of [[false, 401], [true, 403]] as const) {
    const response = await handleControl(request(authenticated), path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: authenticated ? "FORBIDDEN" : "UNAUTHORIZED" });
  }
});
test("owner diagnostic returns only configuration, length and known SHA-256 prefix without logging", async (t) => {
  const logs = setup(t); process.env.AGENT_ENROLLMENT_SECRET = "abc";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://fixture.supabase.co/auth/v1/user");
    return Response.json({ id: owner });
  });
  const response = await handleControl(request(), path);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text(); assert.ok(!text.includes(process.env.AGENT_ENROLLMENT_SECRET));
  assert.deepEqual(JSON.parse(text), { configured: true, length: 3, fingerprint: "ba7816bf8f01" });
  assert.deepEqual(logs, []);
});
test("missing enrollment configuration reports false and the empty-string hash without failing", async (t) => {
  setup(t); delete process.env.AGENT_ENROLLMENT_SECRET;
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: owner }));
  const response = await handleControl(request(), path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, length: 0, fingerprint: "e3b0c44298fc" });
});
