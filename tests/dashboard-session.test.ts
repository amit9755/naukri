import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server.js";
import { POST } from "../src/app/api/auth/[action]/route.ts";
import { dashboardUser, handleControl } from "../src/lib/server/control.ts";

function fixture(t: TestContext) {
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const owner = randomUUID(), other = randomUUID();
  let current = randomBytes(24).toString("hex"), refresh = randomBytes(24).toString("hex");
  const stale = randomBytes(24).toString("hex");
  let wrongOwner = false;
  Object.assign(process.env, { APP_ORIGIN: "https://dashboard.example", SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture-key", DASHBOARD_USER_ID: owner, AGENT_ENROLLMENT_SECRET: "fixture-only" });
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => { logs.push(line); });
  const sensitive = [current, refresh, stale];
  t.after(() => { for (const value of sensitive) assert.ok(!logs.join("").includes(value), "logs must exclude session values"); });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token?grant_type=password")) return Response.json({ user: { id: owner }, access_token: current, refresh_token: refresh, expires_in: 3600 });
    if (url.endsWith("/token?grant_type=refresh_token")) {
      assert.ok(JSON.parse(String(init.body)).refresh_token === refresh, "refresh must receive the issued refresh cookie");
      current = randomBytes(24).toString("hex"); refresh = randomBytes(24).toString("hex"); sensitive.push(current, refresh);
      return Response.json({ user: { id: owner }, access_token: current, refresh_token: refresh, expires_in: 3600 });
    }
    if (url.endsWith("/auth/v1/user")) {
      if (new Headers(init.headers).get("authorization") !== `Bearer ${current}`) return Response.json({ code: "bad_jwt" }, { status: 401 });
      return Response.json({ id: wrongOwner ? other : owner });
    }
    assert.ok(url.startsWith("https://fixture.supabase.co/rest/v1/agents?"), "unexpected request");
    return Response.json([]);
  });
  const auth = (action: string, cookie = "") => POST(new Request(`https://dashboard.example/api/auth/${action}`, { method: "POST", headers: { origin: "https://dashboard.example", "content-type": "application/json", cookie }, body: JSON.stringify({ email: "fixture@example.invalid", password: "fixture-only" }) }), { params: Promise.resolve({ action }) });
  function browserCookies(response: Response) {
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cookie of cookies) assert.ok(/HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=strict/i.test(cookie) && /Path=\//i.test(cookie), "secure cookie attributes retained");
    return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  }
  const request = (cookie: string) => new Request("https://dashboard.example/api/dashboard/status", { headers: { cookie } });
  async function accepted(cookie: string) {
    const status = await handleControl(request(cookie), "dashboard/status");
    assert.equal(status.status, 200);
    const diagnostic = await handleControl(request(cookie), "dashboard/enrollment-diagnostic");
    assert.equal(diagnostic.status, 200);
  }
  return { auth, browserCookies, request, accepted, stale, setWrongOwner: () => { wrongOwner = true; } };
}
test("issued login cookies are accepted by dashboard status and enrollment diagnostic", async (t) => {
  const f = fixture(t); await f.accepted(f.browserCookies(await f.auth("login")));
});
test("refresh response cookies are accepted by dashboard APIs", async (t) => {
  const f = fixture(t); const login = f.browserCookies(await f.auth("login"));
  await f.accepted(f.browserCookies(await f.auth("session", login)));
  assert.equal((await handleControl(f.request(login), "dashboard/status")).status, 401);
});
test("duplicate stale cookie reproduces page success and API failure; login and refresh use identical parsing", async (t) => {
  const f = fixture(t);
  let cookies = `naukri_access=${f.stale}; ${f.browserCookies(await f.auth("login"))}`;
  // Server Components normalize with Next's cookie jar before calling dashboardUser.
  const normalized = new NextRequest(f.request(cookies)).cookies.toString();
  assert.ok(await dashboardUser(f.request(normalized)), "page accepts the normalized session");
  await f.accepted(cookies);
  cookies = `naukri_access=${f.stale}; ${f.browserCookies(await f.auth("session", cookies))}`;
  await f.accepted(cookies);
});
test("missing and invalid cookies stay unauthorized; a verified non-owner remains forbidden", async (t) => {
  const f = fixture(t);
  for (const cookie of ["", `naukri_access=${f.stale}`]) {
    for (const path of ["dashboard/status", "dashboard/enrollment-diagnostic"]) assert.equal((await handleControl(f.request(cookie), path)).status, 401);
  }
  const cookie = f.browserCookies(await f.auth("login"));
  // Never try every duplicate until one authenticates: verify only the value
  // selected by Next, even if a different duplicate would be valid.
  assert.equal((await handleControl(f.request(`${cookie}; naukri_access=${f.stale}`), "dashboard/status")).status, 401);
  f.setWrongOwner();
  for (const path of ["dashboard/status", "dashboard/enrollment-diagnostic"]) assert.equal((await handleControl(f.request(cookie), path)).status, 403);
});
