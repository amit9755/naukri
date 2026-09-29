import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { readSessionSignals } from "./session-signals.ts";
import { inspectSession } from "./local-session.ts";

type ElementOptions = { type?: string; name?: string; placeholder?: string; autocomplete?: string; text?: string; hidden?: boolean; src?: string; title?: string; attributes?: Record<string, string> };
function element(options: ElementOptions = {}) {
  return {
    type: options.type ?? "text", name: options.name ?? "", id: "", placeholder: options.placeholder ?? "",
    autocomplete: options.autocomplete ?? "", labels: [], textContent: options.text ?? "",
    src: options.src ?? "", title: options.title ?? "", hidden: !!options.hidden,
    getAttribute: (name: string) => options.attributes?.[name] ?? null,
    hasAttribute: (name: string) => options.attributes?.[name] !== undefined,
    getClientRects: () => options.hidden ? [] : [{}],
    get value(): never { throw new Error("Input values must never be inspected"); },
  };
}
export function signalsFixture(options: { body?: string; inputs?: ElementOptions[]; frames?: ElementOptions[]; prompts?: ElementOptions[]; widgets?: ElementOptions[] } = {}) {
  const inputs = (options.inputs ?? [{ name: "email" }, { type: "password", name: "password" }]).map(element);
  const document = {
    title: "Naukri Login", body: { innerText: options.body ?? "Email ID / Username Password Login Use OTP to Login Forgot Password Sign in with Google" },
    querySelectorAll: (selector: string) => {
      if (selector === "input") return inputs;
      if (selector === "iframe") return (options.frames ?? []).map(element);
      if (selector.startsWith("[data-sitekey]")) return (options.widgets ?? []).map(element);
      if (selector.startsWith("h1,")) return (options.prompts ?? []).map(element);
      if (selector.startsWith("a, button")) return [element({ text: "Use OTP to Login" }), element({ text: "Forgot Password" }), element({ text: "Sign in with Google" })];
      throw new Error("Unexpected selector in fixture");
    },
  };
  return runInNewContext(`(${readSessionSignals.toString()})()`, {
    document, getComputedStyle: (node: { hidden: boolean }) => ({ display: node.hidden ? "none" : "block", visibility: "visible" }),
  }) as ReturnType<typeof readSessionSignals>;
}

for (const alternative of ["Use OTP to Login", "Forgot Password", "Sign in with Google"]) {
  test(`${alternative} on a normal login page is not an active challenge`, async () => {
    const signals = signalsFixture({ body: `Email ID / Username Password Login ${alternative}` });
    assert.equal(signals.verificationDetected, false);
    assert.equal(signals.captchaDetected, false);
    assert.equal(signals.accessDenied, false);
    const page = { url: () => "https://www.naukri.com/nlogin/login", evaluate: async () => signals } as unknown as Page;
    const state = await inspectSession(page, 200);
    assert.equal(state.challengeDetected, "none");
    assert.equal(state.outcome, "AUTH_REQUIRED");
  });
}

test("actual visible OTP input requires manual verification", async () => {
  const signals = signalsFixture({ inputs: [{ autocomplete: "one-time-code", placeholder: "Enter OTP" }] });
  assert.equal(signals.otpInput, true);
  assert.equal(signals.verificationDetected, true);
  const page = { url: () => "https://www.naukri.com/nlogin/login", evaluate: async () => signals } as unknown as Page;
  assert.equal((await inspectSession(page, 200)).challengeDetected, "otp");
});

test("visible authenticator input or MFA request remains protected", () => {
  assert.equal(signalsFixture({ inputs: [{ placeholder: "Authenticator code" }] }).mfaDetected, true);
  assert.equal(signalsFixture({ prompts: [{ text: "Approve this sign in on your phone" }] }).mfaDetected, true);
});

test("visible CAPTCHA UI requires manual verification", () => {
  const signals = signalsFixture({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor", title: "reCAPTCHA" }] });
  assert.equal(signals.captchaDetected, true);
  assert.equal(signals.verificationDetected, true);
  assert.equal(signalsFixture({ widgets: [{ attributes: { "data-sitekey": "fixture" } }] }).captchaDetected, true);
});

test("hidden verification controls and inactive CAPTCHA widgets do not trigger", () => {
  const signals = signalsFixture({
    inputs: [{ name: "otp", hidden: true }, { type: "password" }],
    frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?size=invisible" }],
    widgets: [{ attributes: { "data-sitekey": "fixture", "data-size": "invisible" } }],
  });
  assert.equal(signals.verificationDetected, false);
});

test("explicit access restriction remains manual-only", async () => {
  const signals = signalsFixture({ body: "Access denied. Your request was blocked." });
  assert.equal(signals.accessDenied, true);
  const page = { url: () => "https://www.naukri.com/nlogin/login", evaluate: async () => signals } as unknown as Page;
  const state = await inspectSession(page, 403);
  assert.equal(state.challengeDetected, "access-restriction");
  assert.equal(state.outcome, "BLOCKED");
});

test("explicit verification prompt stays protected without a code input", () => {
  assert.equal(signalsFixture({ prompts: [{ text: "Verify you are human" }] }).verificationDetected, true);
});
