import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "@/lib/browser";

export const runtime = "nodejs";
export const maxDuration = 120;

const headers = { "Cache-Control": "no-store" };

// Generic, passive challenge signals, not selectors for Naukri account data.
async function inspectPage(page: Page, status: number | null) {
  const snapshot = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" &&
        element.getClientRects().length > 0;
    };
    const challengeFrame = Array.from(document.querySelectorAll("iframe"))
      .some((frame) => visible(frame) &&
        /captcha|challenges\.cloudflare\.com/i.test(`${frame.src} ${frame.title}`));
    return {
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 50_000),
      challengeFrame,
      passwordInput: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
    };
  });
  const url = new URL(page.url());
  const text = `${snapshot.title}\n${snapshot.text}`;
  const captchaDetected = snapshot.challengeFrame ||
    /\bcaptcha\b|i(?:'|’)m not a robot|i am not a robot/i.test(text);
  const accessDenied = [403, 429].includes(status ?? 0) ||
    /access denied|access forbidden|request (?:was )?(?:blocked|rejected)|you (?:have been|are) blocked|unusual traffic|automated (?:access|requests).*?(?:blocked|denied)|pardon our interruption/i.test(text);
  const botProtectionDetected =
    /checking your browser|just a moment|verify (?:that )?you(?:'re| are) (?:a )?human|are you (?:a )?human|performing security verification|enable javascript and cookies to continue|bot detection|bot protection/i.test(text) ||
    /\/cdn-cgi\/challenge|\/challenge(?:\/|$)/i.test(url.pathname);
  const loginDetected = snapshot.passwordInput || /\/(?:login|signin|sign-in)(?:\/|$)/i.test(url.pathname);
  const verificationDetected = captchaDetected || botProtectionDetected ||
    /\botp\b|one[- ]time (?:password|passcode|code)|security verification|verify your (?:identity|email|mobile|phone)|verification code/i.test(text);

  return {
    title: snapshot.title,
    // Query strings/fragments can contain challenge tokens; omit them.
    url: `${url.origin}${url.pathname}`,
    captchaDetected, accessDenied, botProtectionDetected,
    loginDetected, verificationDetected,
    onNaukri: url.hostname === "naukri.com" || url.hostname.endsWith(".naukri.com"),
  };
}

export async function GET() {
  if (process.env.VERCEL === "1" && process.env.ENABLE_NAUKRI_TEST !== "true") {
    return Response.json({ success: false, message: "Naukri test disabled" }, { status: 404, headers });
  }

  let browser: Browser | undefined;
  let stage = "launch";
  let status: number | null = null;
  const startedAt = Date.now();

  try {
    browser = await launchBrowser();
    // Isolated anonymous context: no credentials, storageState, or saved cookies.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        status = response.status();
      }
    });
    stage = "navigation";
    let navigationError: "TIMEOUT" | "NAVIGATION_FAILED" | null = null;
    try {
      await page.goto("https://www.naukri.com/", {
        waitUntil: "domcontentloaded", timeout: 25_000,
      });
    } catch (error) {
      navigationError = error instanceof Error && error.name === "TimeoutError"
        ? "TIMEOUT" : "NAVIGATION_FAILED";
    }

    stage = "inspection";
    let diagnostic = await inspectPage(page, status);
    const stopped = () => diagnostic.captchaDetected || diagnostic.accessDenied ||
      diagnostic.verificationDetected || diagnostic.loginDetected;
    // Briefly observe client-rendered challenges, without waiting for networkidle.
    // Stop at the first signal; never interact with or retry a challenge.
    for (let observation = 0; observation < 4 && !stopped() && !navigationError; observation++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      diagnostic = await inspectPage(page, status);
    }

    const { onNaukri, ...details } = diagnostic;
    const reachable = onNaukri && status !== null && status >= 200 && status < 400 &&
      !stopped() && !navigationError && details.title.trim().length > 0;
    const result = {
      success: reachable, reachable, status, ...details,
      navigationError, stopped: stopped(),
      timestamp: new Date().toISOString(),
    };
    console.info(JSON.stringify({
      event: "NAUKRI_ACCESS_TEST", status: reachable ? "REACHABLE" : stopped() ? "STOPPED" : "FAILED",
      httpStatus: status, captchaDetected: details.captchaDetected,
      accessDenied: details.accessDenied, verificationDetected: details.verificationDetected,
      loginDetected: details.loginDetected, durationMs: Date.now() - startedAt,
    }));
    // HTTP 200 means diagnostic completed; upstream HTTP status is in the body.
    return Response.json(result, { headers });
  } catch {
    console.error(JSON.stringify({ event: "NAUKRI_ACCESS_TEST", status: "FAILED", stage }));
    return Response.json({
      success: false, reachable: false, status, stage,
      message: "Diagnostic could not complete; detection results are unknown.",
      timestamp: new Date().toISOString(),
    }, { status: 500, headers });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        console.error(JSON.stringify({ event: "NAUKRI_ACCESS_TEST", status: "CLEANUP_FAILED" }));
      }
    }
  }
}
