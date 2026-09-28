import type { Browser } from "playwright-core";
import { launchBrowser } from "@/lib/browser";

export const runtime = "nodejs";
export const maxDuration = 120;

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  // Enable explicitly on Vercel during Phase 1, then disable after testing.
  if (process.env.VERCEL === "1" && process.env.ENABLE_BROWSER_TEST !== "true") {
    return Response.json({ success: false, message: "Browser test disabled" }, {
      status: 404, headers,
    });
  }

  let browser: Browser | undefined;
  let stage = "launch";
  const startedAt = Date.now();

  try {
    browser = await launchBrowser();
    stage = "navigation";
    const page = await browser.newPage();
    const response = await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    if (!response?.ok()) throw new Error("Public page request failed");

    stage = "verification";
    const pageTitle = await page.title();
    if (pageTitle !== "Example Domain") throw new Error("Unexpected page title");

    return Response.json({
      success: true,
      browser: "launched",
      pageTitle,
      timestamp: new Date().toISOString(),
    }, { headers });
  } catch {
    // No raw browser errors, headers, or environment values in logs/responses.
    console.error(JSON.stringify({
      event: "BROWSER_TEST", status: "FAILED", stage,
      durationMs: Date.now() - startedAt,
    }));
    return Response.json({
      success: false, stage,
      message: "Browser test failed. Check browser installation and server logs.",
      timestamp: new Date().toISOString(),
    }, { status: 500, headers });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        console.error(JSON.stringify({ event: "BROWSER_TEST", status: "CLEANUP_FAILED" }));
      }
    }
  }
}
