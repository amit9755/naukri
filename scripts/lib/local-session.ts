import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";

import { assertOutsideRepository, LocalChromeError, localChromePaths, resolveChromeExecutable } from "./local-chrome.ts";

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
  const { profileDirectory } = localChromePaths();
  const executablePath = await resolveChromeExecutable();
  await assertOutsideRepository(profileDirectory);
  // Preserve macOS privacy; POSIX masks do not establish Windows ACLs.
  const previousMask = process.platform === "darwin" ? process.umask(0o077) : undefined;
  const controller = new AbortController();
  let context: BrowserContext | undefined;
  const stop = () => {
    process.exitCode = 130;
    controller.abort();
    void context?.close().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await privateDirectory(join(profileDirectory, ".."));
    await privateDirectory(profileDirectory);
    await assertOutsideRepository(profileDirectory);
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath, headless: false, timeout: 20_000,
      slowMo: options.slowMo ?? 0,
    });
    context.once("close", () => controller.abort());
    if (!controller.signal.aborted) await action(context, controller.signal);
  } finally {
    try {
      await context?.close();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (previousMask !== undefined) process.umask(previousMask);
    }
  }
}

export async function navigateToDashboard(page: Page) {
  let status: number | null = null;
  let navigationError: string | null = null;
  const responseListener = (response: import("playwright-core").Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
  };
  page.on("response", responseListener);
  try {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
  } catch (error) {
    navigationError = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NAVIGATION_FAILED";
  } finally {
    page.off("response", responseListener);
  }
  return { status, navigationError };
}

// Passive heuristics only. No account fields, cookies, input values, or page text
// leave the browser; unknown pages must not be treated as authenticated.
export async function inspectSession(page: Page, status: number | null) {
  const signals = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    };
    const text = `${document.title}\n${document.body?.innerText ?? ""}`;
    const captchaDetected = /\bcaptcha\b|i(?:'|’)m not a robot/i.test(text) ||
      Array.from(document.querySelectorAll("iframe")).some((frame) =>
        visible(frame) && /captcha|challenges\.cloudflare\.com/i.test(`${frame.src} ${frame.title}`));
    const accessDenied = /access denied|access forbidden|request (?:was )?(?:blocked|rejected)|you (?:have been|are) blocked|unusual traffic|pardon our interruption/i.test(text);
    const verificationDetected = captchaDetected || /checking your browser|just a moment|verify (?:that )?you(?:'re| are) (?:a )?human|security verification|verification code|\botp\b|one[- ]time (?:password|passcode|code)|verify your (?:identity|email|mobile|phone)|enable javascript and cookies to continue|bot protection/i.test(text);
    const passwordForm = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
    // Require positive account evidence, not merely a 200 response or dashboard URL.
    const signOutVisible = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]'))
      .some((element) => visible(element) && /^(?:log\s*out|sign\s*out)$/i.test(element.textContent?.trim() ?? ""));
    return { captchaDetected, accessDenied, verificationDetected, passwordForm, signOutVisible };
  });
  const url = new URL(page.url());
  const onNaukri = url.hostname === "www.naukri.com" || url.hostname === "naukri.com";
  const accessDenied = signals.accessDenied || status === 403 || status === 429;
  const verificationDetected = signals.verificationDetected || /\/challenge|\/verify|\/verification|\/otp/i.test(url.pathname);
  const loginRequired = signals.passwordForm || /\/(?:login|signin|sign-in)(?:\/|$)/i.test(url.pathname);
  const blocked = accessDenied || signals.captchaDetected || verificationDetected;
  const accountRoute = onNaukri && /^\/mnjuser(?:\/|$)/.test(url.pathname);
  const authenticated = accountRoute &&
    signals.signOutVisible && !blocked && !loginRequired;
  return {
    authenticated, profileAccessible: authenticated,
    accessDenied, captchaDetected: signals.captchaDetected, verificationDetected,
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
