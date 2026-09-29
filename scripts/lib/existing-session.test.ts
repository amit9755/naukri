import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { checkExistingSession } from "./existing-session.ts";
import { sessionErrorCategory } from "./session-diagnostics.ts";

function fixture(options: { authenticated?: boolean; redirect?: boolean; redirectDuringEvaluate?: boolean; error?: Error; pageClosed?: boolean; browserClosed?: boolean; status?: number } = {}) {
  let url = options.redirect ? "https://www.naukri.com/nlogin/login?session=private" : "https://www.naukri.com/mnjuser/homepage";
  let evaluations = 0;
  let navigations = 0;
  const page = {
    url: () => url,
    isClosed: () => !!options.pageClosed,
    context: () => ({ browser: () => ({ isConnected: () => !options.browserClosed }) }),
    evaluate: async () => {
      evaluations++;
      if (options.redirectDuringEvaluate) {
        url = "https://www.naukri.com/nlogin/login?session=private";
        throw new Error("Execution context was destroyed, most likely because of a navigation. private-token");
      }
      if (options.error) throw options.error;
      return { captchaDetected: false, accessDenied: false, verificationDetected: false,
        passwordForm: !options.authenticated, signOutVisible: !!options.authenticated };
    },
  } as unknown as Page;
  const navigate = async () => { navigations++; return { status: options.status ?? 200, navigationError: null }; };
  const run = () => checkExistingSession(page, new AbortController().signal, undefined, undefined, navigate);
  return { page, navigate, run, evaluations: () => evaluations, navigations: () => navigations };
}

test("valid existing authentication requires positive page evidence", async () => {
  const f = fixture({ authenticated: true });
  const result = await f.run();
  assert.equal(result.existingSessionAuthenticated, true);
  assert.equal(result.stage, "existing-session-auth-detection");
  assert.equal(f.evaluations(), 1);
  assert.equal(f.navigations(), 1);
});

test("normal logged-out page is a state, not an exception", async () => {
  const result = await fixture().run();
  assert.equal(result.existingSessionAuthenticated, false);
  assert.equal(result.errorCategory, undefined);
});

test("profile redirect to login is recognized before evaluating the departing document", async () => {
  const f = fixture({ redirect: true });
  const result = await f.run();
  assert.equal(result.existingSessionAuthenticated, false);
  assert.equal(result.reason, "profile redirected to login");
  assert.equal(result.stage, "existing-session-page-check");
  assert.equal(f.evaluations(), 0);
  assert.doesNotMatch(JSON.stringify(result), /session=|private|https:/);
});

test("redirect interrupting page.evaluate continues only for confirmed official login destination", async () => {
  const f = fixture({ redirectDuringEvaluate: true });
  const result = await f.run();
  assert.equal(result.existingSessionAuthenticated, false);
  assert.equal(result.reason, "profile redirected to login");
  assert.equal(f.evaluations(), 1);
  assert.equal(f.navigations(), 1);
  assert.doesNotMatch(JSON.stringify(result), /private|https:/);
  const interrupted = await fixture({ error: new Error("Execution context was destroyed private-token") }).run();
  assert.equal(interrupted.existingSessionAuthenticated, undefined);
  assert.equal(interrupted.errorCategory, "navigation-interrupted");
});

test("existing-session navigation timeout stops without evaluating or retrying", async () => {
  const f = fixture();
  let attempts = 0;
  const result = await checkExistingSession(f.page, new AbortController().signal, undefined, undefined,
    async () => { attempts++; return { status: null, navigationError: "TIMEOUT" }; });
  assert.equal(result.stage, "existing-session-navigation");
  assert.equal(result.errorCategory, "navigation-timeout");
  assert.equal(result.existingSessionAuthenticated, undefined);
  assert.equal(f.evaluations(), 0);
  assert.equal(attempts, 1);
});

test("closed page and disconnected browser are distinct sanitized failures", async () => {
  for (const [options, category] of [
    [{ pageClosed: true }, "page-closed"],
    [{ pageClosed: true, browserClosed: true }, "browser-closed"],
  ] as const) {
    const f = fixture(options);
    const result = await f.run();
    assert.equal(result.errorCategory, category);
    assert.equal(result.existingSessionAuthenticated, undefined);
    assert.equal(f.evaluations(), 0);
    assert.equal(f.navigations(), 0);
  }
});

test("unexpected response status fails at response-check", async () => {
  const f = fixture({ status: 503 });
  const result = await f.run();
  assert.equal(result.stage, "existing-session-response-check");
  assert.equal(result.errorCategory, "unexpected-status");
  assert.equal(f.evaluations(), 0);
});

test("raw errors never leave category classifier or existing-session result", async () => {
  const f = fixture();
  for (const [message, category] of [
    ["net::ERR_NAME_NOT_RESOLVED https://example.invalid/?token=secret", "dns-failure"],
    ["net::ERR_CONNECTION_REFUSED password=secret", "connection-failure"],
    ["unknown private browser state", "unknown"],
  ]) {
    const error = new Error(message);
    assert.equal(sessionErrorCategory(error, f.page), category);
    const result = await fixture({ error }).run();
    assert.equal(result.stage, "existing-session-auth-detection");
    assert.equal(result.errorCategory, category);
    assert.doesNotMatch(JSON.stringify(result), /secret|private|https:|password|stack/);
  }
});


test("page or browser closing during navigation stops before authentication detection", async () => {
  for (const kind of ["pageClosed", "browserClosed"] as const) {
    const options = { pageClosed: false, browserClosed: false };
    const f = fixture(options);
    let attempts = 0;
    const result = await checkExistingSession(f.page, new AbortController().signal, undefined, undefined, async () => {
      attempts++;
      options[kind] = true;
      return { status: 200, navigationError: null };
    });
    assert.equal(result.errorCategory, kind === "pageClosed" ? "page-closed" : "browser-closed");
    assert.equal(result.existingSessionAuthenticated, undefined);
    assert.equal(f.evaluations(), 0);
    assert.equal(attempts, 1);
  }
});
