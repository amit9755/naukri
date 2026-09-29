import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Frame, Page } from "playwright-core";

import { assertOutsideRepository, LocalChromeError, localChromeLaunchOptions, localChromePaths, resolveChromeExecutable } from "./local-chrome.ts";

import { sessionErrorCategory } from "./session-diagnostics.ts";
import type { SessionErrorCategory } from "./session-diagnostics.ts";

import { readSessionSignals } from "./session-signals.ts";
import type { ChallengeDetected } from "./session-signals.ts";

import { localProfileInfo } from "./profile-info.ts";
import { runPersistentSession } from "./session-lifecycle.ts";

export const dashboardUrl = "https://www.naukri.com/mnjuser/homepage";

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "darwin" && info.uid !== process.getuid?.())) {
    throw new Error("Profile directory must be an ordinary directory owned by the current user.");
  }
  // Windows uses the per-user LocalAppData directory’s inherited ACLs.
  if (process.platform === "darwin") await chmod(directory, 0o700);
}

export async function withLocalSession(
  action: (context: BrowserContext, signal: AbortSignal) => Promise<void>,
  options: { slowMo?: number } = {},
) {
  const { profileDirectory, candidates } = localChromePaths();
  const executablePath = await resolveChromeExecutable(candidates);
  await assertOutsideRepository(profileDirectory);
  if (process.env.NAUKRI_DIAGNOSTIC === "true") console.log(JSON.stringify(await localProfileInfo(profileDirectory)));
  // Preserve macOS privacy; POSIX masks do not establish Windows ACLs.
  const previousMask = process.platform === "darwin" ? process.umask(0o077) : undefined;
  try {
    await privateDirectory(join(profileDirectory, ".."));
    await privateDirectory(profileDirectory);
    await assertOutsideRepository(profileDirectory);
    await runPersistentSession(() => chromium.launchPersistentContext(profileDirectory, {
      ...localChromeLaunchOptions(),
      executablePath, headless: false, timeout: 20_000,
      slowMo: options.slowMo ?? 0,
    }), action);
  } finally {
    if (previousMask !== undefined) process.umask(previousMask);
  }
}

export async function navigateToDashboard(page: Page, onError?: (category: SessionErrorCategory) => void): Promise<{ status: number | null; navigationError: string | null }> {
  let status: number | null = null;
  let navigationError: string | null = null;
  const responseListener = (response: import("playwright-core").Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
  };
  page.on("response", responseListener);
  try {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
  } catch (error) {
    onError?.(sessionErrorCategory(error, page));
    navigationError = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NAVIGATION_FAILED";
  } finally {
    page.off("response", responseListener);
  }
  return { status, navigationError };
}

// Passive heuristics only. No account fields, cookies, input values, or page text
// leave the browser; unknown pages must not be treated as authenticated.
export async function inspectSession(page: Page | Frame, status: number | null) {
  const signals = await page.evaluate(readSessionSignals);
  const url = new URL(page.url());
  const onNaukri = url.hostname === "www.naukri.com" || url.hostname === "naukri.com";
  const accessDenied = signals.accessDenied || status === 403 || status === 429;
  const challengeRoute = /\/(?:challenge|verify|verification|otp)(?:\/|$)/i.test(url.pathname);
  const verificationDetected = signals.verificationDetected || challengeRoute;
  const challengeDetected: ChallengeDetected = accessDenied ? "access-restriction" :
    signals.captchaDetected ? "captcha" : signals.mfaDetected ? "mfa" : signals.otpInput ? "otp" :
    verificationDetected ? "unknown" : "none";
  const loginRequired = signals.passwordForm || /\/(?:login|signin|sign-in)(?:\/|$)/i.test(url.pathname);
  const blocked = accessDenied || signals.captchaDetected || verificationDetected;
  const accountRoute = onNaukri && /^\/mnjuser(?:\/|$)/.test(url.pathname);
  const authenticated = accountRoute &&
    signals.signOutVisible && !blocked && !loginRequired;
  return {
    authenticated, profileAccessible: authenticated,
    accessDenied, captchaDetected: signals.captchaDetected, verificationDetected, challengeDetected,
    loginRequired,
    evidence: { accountRoute, signOutVisible: signals.signOutVisible },
    outcome: blocked ? "BLOCKED" : loginRequired ? "AUTH_REQUIRED" : authenticated ? "AUTHENTICATED" : "UNKNOWN",
  };
}

export function reportSessionError(error?: unknown) {
  if (error instanceof LocalChromeError) console.error(error.message);
  // Raw browser errors may include profile paths or navigation/session tokens.
  console.error("Session command stopped. Check Chrome is installed, the dedicated profile is not already open, and the browser was not closed early. No login retry was attempted.");
  process.exitCode = 1;
}
