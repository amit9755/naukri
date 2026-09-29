import type { Frame, Page } from "playwright-core";
import { loginFieldCandidates } from "./login-fields.ts";

export type LoginStructure = {
  frameCount: number;
  detectionFrame: "main" | "child" | "none";
  loginFormVisible: boolean;
  visibleInputCount: number;
  visibleButtonCount: number;
  usernameCandidateCount: number;
  passwordCandidateCount: number;
  submitCandidateCount: number;
  readinessTimedOut: boolean;
};

export function trustedLoginFrame(frame: Frame, page: Page) {
  if (frame.isDetached()) return false;
  const source = new URL(page.url());
  const target = new URL(frame.url());
  return source.protocol === "https:" && source.hostname === "www.naukri.com" && target.origin === source.origin;
}

// Same-origin child frames only. Never inspect challenge/provider/advertising frames.
async function visibleFrame(frame: Frame, main: Frame) {
  for (let current: Frame | null = frame; current && current !== main; current = current.parentFrame()) {
    const element = await current.frameElement();
    try {
      if (!await element.isVisible()) return false;
    } finally {
      await element.dispose();
    }
  }
  return true;
}

export async function discoverLoginForm(page: Page, candidates = loginFieldCandidates) {
  const deadline = Date.now() + 5_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  let readinessTimedOut = false;
  const bounded = async (operation: () => Promise<unknown>) => {
    try { await operation(); } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      readinessTimedOut = true;
    }
  };
  // The same Page that received goto(loginUrl) is brought forward by the caller.
  await bounded(() => page.waitForLoadState("domcontentloaded", { timeout: remaining() }));
  const main = page.mainFrame();
  const inspect = async (frame: Frame, wait: boolean) => {
    const fields = candidates(frame);
    if (wait && Date.now() < deadline) {
      // Locator waits are passive readiness checks, not interaction or login retries.
      // first() is used only for waiting; filling still requires unique candidates.
      await Promise.all([fields.username, fields.password, fields.login].map((field) =>
        bounded(() => field.first().waitFor({ state: "visible", timeout: remaining() }))));
    }
    const [usernameCandidateCount, passwordCandidateCount, submitCandidateCount, visibleInputCount, visibleButtonCount] = await Promise.all([
      fields.username.count(), fields.password.count(), fields.login.count(),
      frame.locator("input").filter({ visible: true }).count(),
      frame.getByRole("button").filter({ visible: true }).count(),
    ]);
    return { frame, fields, usernameCandidateCount, passwordCandidateCount, submitCandidateCount, visibleInputCount, visibleButtonCount };
  };
  const mainResult = await inspect(main, true);
  const frames = page.frames();
  const results = [mainResult];
  for (const frame of frames) {
    if (frame === main || !trustedLoginFrame(frame, page) || !await visibleFrame(frame, main)) continue;
    results.push(await inspect(frame, true));
  }
  const coherent = results.filter((entry) => entry.usernameCandidateCount === 1 && entry.passwordCandidateCount === 1 && entry.submitCandidateCount === 1);
  // Partial forms in another eligible frame also make the choice uncertain.
  const possibleForms = results.filter((entry) => entry.passwordCandidateCount > 0 && (entry.usernameCandidateCount > 0 || entry.submitCandidateCount > 0));
  const selected = coherent.length === 1 && possibleForms.length === 1 ? coherent[0] : undefined;
  const summary = selected ?? mainResult;
  const diagnostics: LoginStructure = {
    frameCount: frames.length,
    detectionFrame: selected ? selected.frame === main ? "main" : "child" : "none",
    loginFormVisible: !!selected,
    visibleInputCount: summary.visibleInputCount, visibleButtonCount: summary.visibleButtonCount,
    usernameCandidateCount: summary.usernameCandidateCount, passwordCandidateCount: summary.passwordCandidateCount,
    submitCandidateCount: summary.submitCandidateCount, readinessTimedOut,
  };
  return { diagnostics, frame: selected?.frame, fields: summary.fields,
    ambiguousFrames: coherent.length > 1 || possibleForms.length > 1 };
}
