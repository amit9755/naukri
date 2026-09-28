import { createInterface } from "node:readline/promises";
import { inspectSession, navigateToDashboard, reportSessionError, withLocalSession } from "./lib/local-session.ts";

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Manual login requires an interactive terminal.");
  }
  await withLocalSession(async (context, signal) => {
    const page = context.pages()[0] ?? await context.newPage();
    await navigateToDashboard(page);
    console.log("Log in manually in the dedicated Chrome window. Enter credentials and any OTP only in Chrome, never in this terminal. Do not save your password in Chrome.");
    console.log("Once your signed-in Naukri dashboard is visible, return here. If access is denied, cancel with Ctrl+C.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question('Type "done" when login is complete (anything else cancels): ', { signal });
      if (answer.trim().toLowerCase() !== "done") {
        console.log("Login setup cancelled.");
        return;
      }
      // Inspect only after the user finishes; never inspect input values.
      const currentPage = context.pages().findLast((candidate) => candidate.url().startsWith("https://www.naukri.com/mnjuser/")) ?? page;
      const result = await inspectSession(currentPage, null);
      if (result.outcome === "BLOCKED" || result.loginRequired) {
        console.log("Login not confirmed: login or verification is still required, or access is denied. Stopping.");
        process.exitCode = 1;
        return;
      }
      console.log(result.authenticated
        ? "Login confirmed. Dedicated Chrome session saved. Closing Chrome."
        : "Login completion confirmed by you; automatic detection was inconclusive. Dedicated Chrome session saved. Closing Chrome.");
    } finally {
      terminal.close();
    }
  });
}

main().catch(reportSessionError);
