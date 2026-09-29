import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame, Page } from "playwright-core";
import { discoverLoginForm } from "./login-discovery.ts";
import type { loginFieldCandidates } from "./login-fields.ts";

type Counts = { username: number; password: number; login: number };
function frameFixture(counts: Counts, origin = "https://www.naukri.com", delayed?: Promise<void>) {
  let searches = 0;
  let parent: Frame | null = null;
  const frame = {
    url: () => `${origin}/nlogin/login?private=not-for-output`,
    isDetached: () => false,
    parentFrame: () => parent,
    frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }),
    locator: () => { searches++; return { filter: () => ({ count: async () => counts.username + counts.password }) }; },
    getByRole: () => { searches++; return { filter: () => ({ count: async () => counts.login }) }; },
  } as unknown as Frame;
  const field = (key: keyof Counts) => {
    const locator = {
      count: async () => counts[key],
      first: () => locator,
      waitFor: async (options: { timeout: number }) => {
        assert.ok(options.timeout > 0 && options.timeout <= 5_000);
        if (delayed) await delayed;
        if (!counts[key]) { const error = new Error(); error.name = "TimeoutError"; throw error; }
      },
    };
    return locator;
  };
  const fields = { username: field("username"), password: field("password"), login: field("login") } as unknown as ReturnType<typeof loginFieldCandidates>;
  return { frame, fields, searches: () => searches, setParent: (value: Frame) => { parent = value; } };
}
function setup(main: ReturnType<typeof frameFixture>, children: ReturnType<typeof frameFixture>[] = []) {
  const all = [main, ...children];
  children.forEach((child) => child.setParent(main.frame));
  const page = {
    url: () => "https://www.naukri.com/nlogin/login",
    mainFrame: () => main.frame,
    frames: () => all.map((entry) => entry.frame),
    waitForLoadState: async (state: string, options: { timeout: number }) => {
      assert.equal(state, "domcontentloaded");
      assert.ok(options.timeout > 0 && options.timeout <= 5_000);
    },
  } as unknown as Page;
  const order: Frame[] = [];
  const candidates: typeof loginFieldCandidates = (target) => {
    order.push(target as Frame);
    const found = all.find((entry) => entry.frame === target);
    assert.ok(found);
    return found.fields;
  };
  return { run: () => discoverLoginForm(page, candidates), order };
}
const complete = () => ({ username: 1, password: 1, login: 1 });
const empty = () => ({ username: 0, password: 0, login: 0 });

test("visible main-frame form is discovered on the explicitly supplied page", async () => {
  const main = frameFixture(complete());
  const f = setup(main);
  const result = await f.run();
  assert.equal(result.frame, main.frame);
  assert.equal(f.order[0], main.frame);
  assert.equal(result.diagnostics.detectionFrame, "main");
  assert.equal(result.diagnostics.loginFormVisible, true);
  assert.equal(result.diagnostics.visibleInputCount, 2);
  assert.equal(result.diagnostics.visibleButtonCount, 1);
});

test("bounded semantic readiness wait handles delayed rendering without navigation retries", async () => {
  const counts = empty();
  let render: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => { render = resolve; });
  const main = frameFixture(counts, undefined, rendered);
  const f = setup(main);
  let done = false;
  const pending = f.run().then((result) => { done = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  Object.assign(counts, complete());
  render!();
  const result = await pending;
  assert.equal(result.diagnostics.loginFormVisible, true);
  assert.equal(result.diagnostics.readinessTimedOut, false);
  assert.equal(f.order.length, 1);
});

test("one same-origin child form is selected after inspecting main frame first", async () => {
  const main = frameFixture(empty());
  const child = frameFixture(complete());
  const f = setup(main, [child]);
  const result = await f.run();
  assert.equal(result.frame, child.frame);
  assert.deepEqual(f.order, [main.frame, child.frame]);
  assert.equal(result.diagnostics.frameCount, 2);
  assert.equal(result.diagnostics.detectionFrame, "child");
});

test("unrelated third-party frames are counted but never searched", async () => {
  const main = frameFixture(complete());
  const unrelated = frameFixture(complete(), "https://unrelated.example");
  const f = setup(main, [unrelated]);
  const result = await f.run();
  assert.equal(result.frame, main.frame);
  assert.equal(unrelated.searches(), 0);
  assert.deepEqual(f.order, [main.frame]);
  assert.equal(result.diagnostics.frameCount, 2);
});

test("multiple eligible login frames are ambiguous, including main plus child", async () => {
  for (const mainCounts of [empty(), complete()]) {
    const main = frameFixture(mainCounts);
    const children = [frameFixture(complete()), frameFixture(complete())];
    const result = await setup(main, children).run();
    assert.equal(result.frame, undefined);
    assert.equal(result.ambiguousFrames, true);
    assert.equal(result.diagnostics.detectionFrame, "none");
    assert.equal(result.diagnostics.loginFormVisible, false);
  }
});

test("zero controls return only structural diagnostics after bounded readiness timeout", async () => {
  const result = await setup(frameFixture(empty())).run();
  assert.deepEqual(result.diagnostics, {
    frameCount: 1, detectionFrame: "none", loginFormVisible: false,
    visibleInputCount: 0, visibleButtonCount: 0, usernameCandidateCount: 0,
    passwordCandidateCount: 0, submitCandidateCount: 0, readinessTimedOut: true,
  });
  assert.equal(result.frame, undefined);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /private|https:|inputValue|passwordValue/);
});
