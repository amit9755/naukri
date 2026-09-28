import { createInterface } from "node:readline/promises";
import type { Page } from "playwright-core";
import { inspectSession, navigateToDashboard, reportSessionError, withLocalSession } from "./lib/local-session.ts";

// Passive observation for client rendering; no navigation or login retries.
async function dashboardAuthenticated(page: Page, signal: AbortSignal) {
  const navigation = await navigateToDashboard(page);
  if (navigation.navigationError || signal.aborted) throw new Error("NAVIGATION_FAILED");
  let result = await inspectSession(page, navigation.status);
  for (let i = 0; i < 6 && result.outcome === "UNKNOWN" && !signal.aborted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await inspectSession(page, navigation.status);
  }
  return !signal.aborted && result.authenticated && navigation.status !== null &&
    navigation.status >= 200 && navigation.status < 300;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Manual login requires an interactive terminal.");
  }
  let authenticated = false;
  await withLocalSession(async (context, signal) => {
    const page = context.pages()[0] ?? await context.newPage();
    authenticated = await dashboardAuthenticated(page, signal);
    if (authenticated) {
      console.log("Existing session is authenticated. Closing dedicated Chrome.");
      return;
    }
    if (signal.aborted) return;
    console.log("Log in manually in the dedicated Chrome window. Enter credentials only in Chrome, never in this terminal. Do not save your password in Chrome.");
    console.log("Complete any OTP, CAPTCHA, or MFA manually in Chrome. Once your signed-in Naukri dashboard is visible, return here. If access is denied, cancel with Ctrl+C.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question('Type "done" when login is complete (anything else cancels): ', { signal });
      if (answer.trim().toLowerCase() !== "done") {
        console.log("Login setup cancelled.");
        return;
      }
      // One read-only dashboard visit after manual completion verifies the session.
      // Never inspect credential inputs, export browser state, or open profile edits.
      const currentPage = context.pages().findLast((candidate) => candidate.url().startsWith("https://www.naukri.com/mnjuser/")) ?? page;
      authenticated = await dashboardAuthenticated(currentPage, signal);
      console.log(authenticated
        ? "Login confirmed. Closing Chrome and preserving the dedicated session."
        : "Authentication not confirmed. Stopping without retry; no profile changes were made.");
    } finally {
      terminal.close();
    }
  });
  // Report success only after the persistent context has closed successfully.
  console.log(JSON.stringify({ authenticated, profileAccessible: authenticated }));
  if (!authenticated && !process.exitCode) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log(JSON.stringify({ authenticated: false, profileAccessible: false }));
  reportSessionError(error);
});
