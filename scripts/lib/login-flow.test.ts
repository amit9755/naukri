import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { credentialsFromEnvironment, runLoginFlow } from "./login-flow.ts";

const credentials = { username: "fixture-user", password: "fixture-password" };
function fixture(options: { already?: boolean; ambiguous?: boolean; challengeAfterFill?: boolean; challengeAfterClick?: boolean; clickFails?: boolean; denied?: boolean; initialChallenge?: boolean; failedLogin?: boolean } = {}) {
  let url = "https://www.naukri.com/mnjuser/homepage";
  let authenticated = !!options.already;
  let challenged = !!options.initialChallenge;
  const actions: string[] = [];
  let clicks = 0;
  const locator = (kind: string) => {
    const value = {
      or: () => value,
      filter: () => value,
      count: async () => options.ambiguous ? 2 : 1,
      isEditable: async () => true,
      isEnabled: async () => true,
      evaluate: async () => true,
      fill: async () => {
        actions.push(kind);
        if (options.challengeAfterFill) challenged = true;
      },
      click: async () => {
        clicks++;
        if (options.clickFails) throw new Error("synthetic click failure");
        if (options.challengeAfterClick) challenged = true;
        else if (!options.failedLogin) {
          authenticated = true;
          url = "https://www.naukri.com/mnjuser/homepage";
        }
      },
    };
    return value;
  };
  const page = {
    url: () => url,
    goto: async (target: string) => { url = target; return { status: () => 200, ok: () => true }; },
    getByLabel: (label: RegExp) => locator(label.test("Password") ? "password" : "username"),
    getByPlaceholder: () => locator("placeholder"),
    getByRole: () => locator("button"),
  } as unknown as Page;
  const inspect = async () => ({
    authenticated, profileAccessible: authenticated, accessDenied: !!options.denied,
    captchaDetected: challenged, verificationDetected: challenged, loginRequired: !authenticated,
    evidence: { accountRoute: authenticated, signOutVisible: authenticated },
    outcome: challenged ? "BLOCKED" : authenticated ? "AUTHENTICATED" : "AUTH_REQUIRED",
  });
  const dashboard = async () => ({ status: 200, navigationError: null });
  const manual = async () => { actions.push("manual"); challenged = false; authenticated = true; url = "https://www.naukri.com/mnjuser/homepage"; return true; };
  const run = (input = credentials) => runLoginFlow(page, new AbortController().signal, input, manual, inspect, dashboard);
  return { run, page, inspect, dashboard, manual, actions, clicks: () => clicks };
}

test("credentials are optional but incomplete configuration fails closed", () => {
  assert.equal(credentialsFromEnvironment({}), undefined);
  assert.equal(credentialsFromEnvironment({ NAUKRI_USERNAME: "", NAUKRI_PASSWORD: "" }), undefined);
  assert.throws(() => credentialsFromEnvironment({ NAUKRI_USERNAME: "fixture" }), /^Error: LOGIN_CONFIGURATION_INCOMPLETE$/);
  assert.deepEqual(credentialsFromEnvironment({ NAUKRI_USERNAME: credentials.username, NAUKRI_PASSWORD: credentials.password }), credentials);
});

test("authenticated session skips credential filling and Login", async () => {
  const f = fixture({ already: true });
  assert.equal((await f.run()).authenticated, true);
  assert.deepEqual(f.actions, []);
  assert.equal(f.clicks(), 0);
});

test("unique login controls are filled once and submitted once", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { authenticated: true, profileAccessible: true, manualVerificationRequired: false });
  assert.deepEqual(f.actions, ["username", "password"]);
  assert.equal(f.clicks(), 1);
});

test("ambiguous selectors and denied access never fill or submit", async () => {
  for (const options of [{ ambiguous: true }, { denied: true }]) {
    const f = fixture(options);
    assert.equal((await f.run()).authenticated, false);
    assert.deepEqual(f.actions, []);
    assert.equal(f.clicks(), 0);
  }
});

test("challenge appearing after first fill stops automated interaction", async () => {
  const f = fixture({ challengeAfterFill: true });
  assert.equal((await f.run()).manualVerificationRequired, true);
  assert.deepEqual(f.actions, ["username", "manual"]);
  assert.equal(f.clicks(), 0);
});

test("challenge after Login hands off manually without resubmission", async () => {
  const f = fixture({ challengeAfterClick: true });
  assert.deepEqual(await f.run(), { authenticated: true, profileAccessible: true, manualVerificationRequired: true });
  assert.deepEqual(f.actions, ["username", "password", "manual"]);
  assert.equal(f.clicks(), 1);
});

test("uncertain click result never triggers another Login click", async () => {
  const f = fixture({ clickFails: true });
  await assert.rejects(f.run());
  assert.equal(f.clicks(), 1);
});

test("missing credentials retain manual login", async () => {
  const f = fixture();
  const status = await runLoginFlow(f.page, new AbortController().signal, undefined, f.manual, f.inspect, f.dashboard);
  assert.equal(status.authenticated, true);
  assert.deepEqual(f.actions, ["manual"]);
  assert.equal(f.clicks(), 0);
});


test("initial challenge leaves credential fields untouched", async () => {
  const f = fixture({ initialChallenge: true });
  const status = await f.run();
  assert.equal(status.manualVerificationRequired, true);
  assert.deepEqual(f.actions, ["manual"]);
  assert.equal(f.clicks(), 0);
});

test("failed login returns false without a second submission", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ failedLogin: true });
  const pending = f.run();
  // Flush only fake observation timers; no browser or network activity.
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(500);
  }
  assert.equal((await pending).authenticated, false);
  assert.equal(f.clicks(), 1);
  assert.deepEqual(f.actions, ["username", "password"]);
});
