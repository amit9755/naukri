import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readSessionSignals } from "./session-signals.ts";
import { inspectSession } from "./local-session.ts";
import type { Frame, Page } from "playwright-core";
import { credentialsFromEnvironment, runLoginFlow } from "./login-flow.ts";

const credentials = { username: "fixture-user", password: "fixture-password" };
function fixture(options: { already?: boolean; ambiguous?: boolean; challengeAfterFill?: boolean; challengeAfterClick?: boolean; clickFails?: boolean; denied?: boolean; initialChallenge?: boolean; failedLogin?: boolean; missing?: string; fillFails?: boolean; manualCancel?: boolean; navigationFails?: boolean; detectionFails?: boolean; wrongLoginPage?: boolean; verificationNavigationFails?: boolean; profileRedirect?: boolean } = {}) {
  let url = options.profileRedirect ? "https://www.naukri.com/nlogin/login" : "https://www.naukri.com/mnjuser/homepage";
  let authenticated = !!options.already;
  let challenged = !!options.initialChallenge;
  const actions: string[] = [];
  let clicks = 0;
  const manualDiagnostics: import("./login-flow.ts").LoginStatus[] = [];
  const locator = (kind: string) => {
    const value = {
      or: () => value,
      and: () => value,
      first: () => value,
      waitFor: async () => { if (options.missing === kind) { const error = new Error(); error.name = "TimeoutError"; throw error; } },
      filter: () => value,
      count: async () => options.ambiguous ? 2 : options.missing === kind ? 0 : 1,
      isEditable: async () => true,
      isEnabled: async () => true,
      evaluate: async () => true,
      fill: async () => {
        actions.push(kind);
        if (options.fillFails) throw new Error("fixture-password fixture-user secret-token");
        if (options.challengeAfterFill) challenged = true;
      },
      click: async () => {
        clicks++;
        if (options.clickFails) throw new Error("fixture-password fixture-user secret-token");
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
    isClosed: () => false,
    isDetached: () => false,
    mainFrame: () => page,
    frames: () => [page],
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    context: () => ({ browser: () => ({ isConnected: () => true }) }),
    goto: async (target: string) => { url = options.wrongLoginPage ? "https://www.naukri.com/unexpected" : target; return { status: () => 200, ok: () => true }; },
    getByLabel: (label: RegExp) => locator(label.test("Password") ? "password" : "username"),
    getByPlaceholder: () => locator("placeholder"),
    getByRole: (role: string, options?: { name: RegExp }) => locator(role === "button" ? "button" : options?.name.test("Password") ? "password" : "username"),
    locator: (selector: string) => locator(selector.includes("password") ? "password" : "username"),
  } as unknown as Page;
  const inspect = async () => {
    if (options.detectionFails) throw new Error("secret-token");
    return ({
    authenticated, profileAccessible: authenticated, accessDenied: !!options.denied,
    captchaDetected: challenged, verificationDetected: challenged, loginRequired: !authenticated,
    challengeDetected: challenged ? "captcha" as const : "none" as const,
    evidence: { accountRoute: authenticated, signOutVisible: authenticated },
    outcome: challenged ? "BLOCKED" : authenticated ? "AUTHENTICATED" : "AUTH_REQUIRED",
  }); };
  let dashboardVisits = 0;
  const dashboard = async () => { dashboardVisits++; return { status: 200, navigationError: options.navigationFails || (options.verificationNavigationFails && dashboardVisits > 1) ? "TIMEOUT" : null }; };
  const manual = async (_verification?: boolean, diagnostic?: import("./login-flow.ts").LoginStatus) => { actions.push("manual"); if (diagnostic) manualDiagnostics.push(diagnostic); if (options.manualCancel) return false; challenged = false; authenticated = true; url = "https://www.naukri.com/mnjuser/homepage"; return true; };
  const run = (input = credentials) => runLoginFlow(page, new AbortController().signal, input, manual, inspect, dashboard);
  return { run, page, inspect, dashboard, manual, actions, manualDiagnostics, clicks: () => clicks };
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
  assert.equal((await f.run()).authenticated, true);
  assert.deepEqual(f.actions, ["username", "password"]);
  assert.equal(f.clicks(), 1);
});

test("ambiguous selectors and denied access never fill or submit", async () => {
  for (const options of [{ ambiguous: true }, { denied: true }]) {
    const f = fixture(options);
    assert.equal((await f.run()).authenticated, false);
    assert.deepEqual(f.actions, "denied" in options ? ["manual"] : []);
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
  const status = await f.run();
  assert.equal(status.authenticated, true);
  assert.equal(status.manualVerificationRequired, true);
  assert.deepEqual(f.actions, ["username", "password", "manual"]);
  assert.equal(f.clicks(), 1);
});

test("uncertain click result never triggers another Login click", async () => {
  const f = fixture({ clickFails: true, manualCancel: true });
  const status = await f.run();
  assert.equal(status.stage, "submit");
  assert.equal(status.authenticated, false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-password|fixture-user|secret-token/);
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
  const f = fixture({ failedLogin: true, manualCancel: true });
  const pending = f.run();
  // Flush only fake observation timers; no browser or network activity.
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(500);
  }
  const status = await pending;
  assert.equal(status.authenticated, false);
  assert.equal(status.stage, "post-submit-navigation");
  assert.match(status.reason, /authentication not confirmed/);
  assert.equal(f.clicks(), 1);
  assert.deepEqual(f.actions, ["username", "password", "manual"]);
});


test("missing controls report exact stages and only element-found booleans", async () => {
  for (const [missing, stage] of [
    ["username", "username-field-detection"],
    ["password", "password-field-detection"],
    ["button", "submit-button-detection"],
  ]) {
    const f = fixture({ missing });
    const status = await f.run();
    assert.equal(status.stage, stage);
    assert.equal(status.credentialsConfigured, true);
    assert.equal(status.usernameFieldFound, missing !== "username");
    assert.equal(status.passwordFieldFound, missing !== "password");
    assert.equal(status.submitButtonFound, missing !== "button");
    assert.match(status.reason, /not found/);
    assert.equal(status.authenticated, false);
    assert.deepEqual(f.actions, []);
    assert.equal(f.clicks(), 0);
  }
});

test("ambiguity is distinguished from a missing field", async () => {
  const status = await fixture({ ambiguous: true }).run();
  assert.equal(status.stage, "username-field-detection");
  assert.equal(status.reason, "expected login field is ambiguous");
});

test("fill errors preserve stage and never expose raw errors", async () => {
  const f = fixture({ fillFails: true });
  const status = await f.run();
  assert.equal(status.stage, "credential-fill");
  assert.equal(status.reason, "operation failed at this stage");
  assert.equal(status.authenticated, false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-password|fixture-user|secret-token/);
  assert.equal(f.clicks(), 0);
});

test("navigation and session-inspection failures have distinct diagnostic stages", async () => {
  const navigation = await fixture({ navigationFails: true }).run();
  assert.equal(navigation.stage, "existing-session-navigation");
  assert.equal(navigation.reason, "existing-session navigation failed");
  const inspection = await fixture({ detectionFails: true }).run();
  assert.equal(inspection.stage, "existing-session-auth-detection");
  assert.equal(inspection.reason, "existing-session operation failed");
  assert.doesNotMatch(JSON.stringify(inspection), /secret-token/);
});

test("challenge handoff reports manual-verification without automated submission", async () => {
  const f = fixture({ initialChallenge: true, manualCancel: true });
  const status = await f.run();
  assert.equal(status.stage, "manual-verification");
  assert.equal(status.manualVerificationRequired, true);
  assert.match(status.reason, /verification challenge/);
  assert.equal(f.clicks(), 0);
});

test("unconfirmed submission waits for explicit manual inspection completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ failedLogin: true });
  let release: ((answer: boolean) => void) | undefined;
  let finished = false;
  const pending = runLoginFlow(f.page, new AbortController().signal, credentials,
    async (_verification, diagnostic) => {
      assert.equal(diagnostic.stage, "post-submit-navigation");
      assert.equal(diagnostic.reason, "authentication not confirmed after submission");
      return new Promise<boolean>((resolve) => { release = resolve; });
    }, f.inspect, f.dashboard).then((status) => { finished = true; return status; });
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(500);
  }
  assert.equal(finished, false);
  assert.equal(f.clicks(), 1);
  assert.ok(release);
  release(false);
  assert.equal((await pending).authenticated, false);
});


test("unexpected login page reports detection failure without filling", async () => {
  const f = fixture({ wrongLoginPage: true });
  const status = await f.run();
  assert.equal(status.stage, "login-page-detection");
  assert.equal(status.reason, "expected login page not found");
  assert.deepEqual(f.actions, []);
  assert.equal(f.clicks(), 0);
});

test("failed authentication navigation pauses at its original stage", async () => {
  const f = fixture({ verificationNavigationFails: true, manualCancel: true });
  const status = await f.run();
  assert.equal(status.stage, "authentication-check");
  assert.match(status.reason, /authenticated page navigation failed after submission/);
  assert.equal(f.manualDiagnostics.length, 1);
  assert.equal(f.manualDiagnostics[0].stage, "authentication-check");
  assert.equal(f.clicks(), 1);
});


test("login controls are inspected only after confirmed unauthenticated state", async () => {
  const f = fixture();
  const progression: import("./login-flow.ts").LoginStatus[] = [];
  const status = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard,
    (entry) => progression.push(entry), true);
  const established = progression.findIndex((entry) => entry.existingSessionAuthenticated === false);
  const fieldDetection = progression.findIndex((entry) => entry.stage === "username-field-detection");
  assert.ok(established >= 0 && fieldDetection > established);
  assert.equal(status.authenticated, true);
  assert.equal(f.clicks(), 1);
});

test("existing-session errors expose category only with diagnostic mode enabled", async () => {
  for (const diagnosticMode of [false, true]) {
    const f = fixture({ navigationFails: true });
    const status = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard, undefined, diagnosticMode);
    assert.equal(status.errorCategory, diagnosticMode ? "navigation-timeout" : undefined);
    assert.equal(status.usernameFieldFound, false);
    assert.equal(status.passwordFieldFound, false);
    assert.equal(status.submitButtonFound, false);
    assert.equal(f.clicks(), 0);
  }
});


test("profile redirect establishes unauthenticated state before continuing to login fields", async () => {
  const f = fixture({ profileRedirect: true });
  const progression: import("./login-flow.ts").LoginStatus[] = [];
  const status = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard,
    (entry) => progression.push(entry), true);
  const redirect = progression.findIndex((entry) => entry.reason === "profile redirected to login");
  const detection = progression.findIndex((entry) => entry.stage === "username-field-detection");
  assert.ok(redirect >= 0 && detection > redirect);
  assert.equal(progression[redirect].existingSessionAuthenticated, false);
  assert.equal(status.authenticated, true);
  assert.equal(f.clicks(), 1);
});


test("diagnostic field failure keeps the flow open until inspection completes, without retry", async () => {
  const f = fixture({ missing: "username" });
  let closeInspection: (() => void) | undefined;
  let finished = false;
  const pending = runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard,
    undefined, true, async (diagnostic) => {
      assert.equal(diagnostic.stage, "username-field-detection");
      assert.equal(diagnostic.usernameCandidateCount, 0);
      assert.equal(diagnostic.passwordCandidateCount, 1);
      assert.equal(diagnostic.submitCandidateCount, 1);
      await new Promise<void>((resolve) => { closeInspection = resolve; });
    }).then((status) => { finished = true; return status; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.ok(closeInspection);
  assert.deepEqual(f.actions, []);
  assert.equal(f.clicks(), 0);
  closeInspection();
  const result = await pending;
  assert.equal(result.authenticated, false);
  assert.equal(result.reason, "expected login field not found");
  assert.deepEqual(f.actions, []);
  assert.equal(f.clicks(), 0);
});

test("non-diagnostic field failure does not request an inspection pause", async () => {
  const f = fixture({ missing: "password" });
  let paused = false;
  const result = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard,
    undefined, false, async () => { paused = true; });
  assert.equal(paused, false);
  assert.equal(result.passwordCandidateCount, 0);
  assert.equal(result.authenticated, false);
  assert.deepEqual(f.actions, []);
});


test("ambiguous main and child forms stop before filling any credentials", async () => {
  const f = fixture();
  const main = f.page.mainFrame();
  const child = {
    ...f.page,
    parentFrame: () => main,
    frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }),
  } as unknown as Frame;
  f.page.frames = () => [main, child];
  const status = await f.run();
  assert.equal(status.reason, "multiple possible login frames found");
  assert.equal(status.detectionFrame, "none");
  assert.equal(status.loginFormVisible, false);
  assert.equal(status.frameCount, 2);
  assert.deepEqual(f.actions, []);
  assert.equal(f.clicks(), 0);
});


test("normal login alternatives pass the real challenge classifier and submit credentials once", async () => {
  const f = fixture();
  const signals = runInNewContext(`(${readSessionSignals.toString()})()`, {
    document: {
      title: "Login",
      body: { innerText: "Email ID / Username Password Login Use OTP to Login Forgot Password Sign in with Google" },
      querySelectorAll: () => [],
    },
  });
  const normal = await inspectSession({ url: () => "https://www.naukri.com/nlogin/login", evaluate: async () => signals } as unknown as Page, 200);
  assert.equal(normal.challengeDetected, "none");
  const status = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual,
    async () => { const state = await f.inspect(); return state.authenticated ? state : normal; }, f.dashboard);
  assert.equal(status.authenticated, true);
  assert.equal(status.manualVerificationRequired, false);
  assert.equal(status.challengeDetected, "none");
  assert.deepEqual(f.actions, ["username", "password"]);
  assert.equal(f.clicks(), 1);
});

test("manual done requires current authenticated evidence before dashboard verification", async () => {
  const f = fixture();
  const events: string[] = [];
  let manualDone = false;
  const status = await runLoginFlow(f.page, new AbortController().signal, undefined,
    async () => { events.push("done"); manualDone = true; return f.manual(); },
    async () => { if (manualDone) events.push("inspect-current"); return f.inspect(); },
    async () => { if (manualDone) events.push("verify-dashboard"); return f.dashboard(); });
  assert.equal(status.authenticated, true);
  assert.equal(status.profileAccessible, true);
  assert.deepEqual(events.slice(0, 3), ["done", "inspect-current", "verify-dashboard"]);
});

test("typing done while still unauthenticated never reports success", async () => {
  const f = fixture();
  let done = false;
  let postDoneNavigations = 0;
  const status = await runLoginFlow(f.page, new AbortController().signal, undefined,
    async () => { done = true; return true; }, f.inspect,
    async () => { if (done) postDoneNavigations++; return f.dashboard(); });
  assert.equal(status.authenticated, false);
  assert.equal(status.profileAccessible, false);
  assert.equal(status.reason, "manual completion is not authenticated; session not confirmed");
  assert.equal(postDoneNavigations, 0);
  assert.equal(f.clicks(), 0);
});


test("manual login completed during diagnostic inspection is verified without resubmitting", async () => {
  const f = fixture({ missing: "username" });
  const status = await runLoginFlow(f.page, new AbortController().signal, credentials, f.manual, f.inspect, f.dashboard,
    undefined, true, async () => { await f.manual(); });
  assert.equal(status.authenticated, true);
  assert.equal(status.profileAccessible, true);
  assert.equal(f.clicks(), 0);
  assert.deepEqual(f.actions, ["manual"]);
});
