import { chromium as playwright } from "playwright-core";

export async function launchBrowser() {
  if (process.env.VERCEL !== "1") {
    return playwright.launch({ headless: true, timeout: 20_000 });
  }

  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Unsupported serverless browser platform");
  }

  const { default: chromium } = await import("@sparticuz/chromium-min");
  // Keep the release pack aligned with the pinned npm package version.
  const packUrl = `https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.${process.arch}.tar`;

  return playwright.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(packUrl),
    headless: true,
    timeout: 20_000,
  });
}
