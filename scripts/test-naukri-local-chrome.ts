import { assertOutsideRepository, LocalChromeError, resolveChromeExecutable } from "./lib/local-chrome.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";

async function inspect(page: Page, status: number | null) {
  const snapshot = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        element.getClientRects().length > 0;
    };
    return {
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 50_000),
      captchaFrame: Array.from(document.querySelectorAll("iframe")).some(
        (frame) => visible(frame) && /captcha|challenges\.cloudflare\.com/i.test(`${frame.src} ${frame.title}`),
      ),
    };
  });
  const text = `${snapshot.title}\n${snapshot.text}`;
  const captchaDetected = snapshot.captchaFrame || /\bcaptcha\b|i(?:'|’)m not a robot|i am not a robot/i.test(text);
  const accessDenied = status === 403 || status === 429 ||
    /access denied|access forbidden|request (?:was )?(?:blocked|rejected)|you (?:have been|are) blocked|unusual traffic|pardon our interruption/i.test(text);
  const verificationDetected = captchaDetected ||
    /checking your browser|just a moment|verify (?:that )?you(?:'re| are) (?:a )?human|security verification|verification code|\botp\b|one[- ]time (?:password|passcode|code)|verify your (?:identity|email|mobile|phone)|enable javascript and cookies to continue|bot protection/i.test(text) ||
    /\/cdn-cgi\/challenge|\/challenge(?:\/|$)/i.test(new URL(page.url()).pathname);
  return { status, title: snapshot.title, url: page.url(), accessDenied, captchaDetected, verificationDetected };
}

async function main() {
  const executablePath = await resolveChromeExecutable();
  await assertOutsideRepository(tmpdir());
  const profile = await mkdtemp(join(tmpdir(), "naukri-chrome-diagnostic-"));
  let context: BrowserContext | undefined;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    process.exitCode = 130;
    void context?.close().catch(() => {});
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    // Standard Playwright defaults: no serverless args, stealth, or UA overrides.
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: false, timeout: 20_000,
    });
    if (interrupted) return;
    const page = context.pages()[0] ?? await context.newPage();
    let status: number | null = null;
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        status = response.status();
      }
    });
    let navigationError: string | null = null;
    try {
      await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 25_000 });
    } catch (error) {
      navigationError = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NAVIGATION_FAILED";
    }
    let result = await inspect(page, status);
    const blocked = () => result.accessDenied || result.captchaDetected || result.verificationDetected;
    // Observe briefly for client-rendered challenges. No second navigation or interaction.
    for (let i = 0; i < 4 && !blocked() && !navigationError && !interrupted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await inspect(page, status);
    }
    console.log(JSON.stringify({ ...result, navigationError, stopped: blocked(), timestamp: new Date().toISOString() }, null, 2));
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ success: false, message: error instanceof LocalChromeError ? error.message : "Local diagnostic stopped. Check Chrome and close any diagnostic browser window. No retry was attempted." }));
  process.exitCode = 1;
});
