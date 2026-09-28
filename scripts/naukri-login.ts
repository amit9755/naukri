import { createInterface } from "node:readline/promises";
import type { LoginStatus } from "./lib/login-flow.ts";

async function main() {
  // Playwright API debugging can include fill values. Refuse before importing it.
  if (process.env.DEBUG || process.env.PWDEBUG) throw new Error("DEBUG_LOGGING_NOT_ALLOWED");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const { credentialsFromEnvironment, runLoginFlow } = await import("./lib/login-flow.ts");
  const credentials = credentialsFromEnvironment(process.env);
  // Keep credentials in this process's memory, not Chrome's inherited environment.
  delete process.env.NAUKRI_USERNAME;
  delete process.env.NAUKRI_PASSWORD;
  const { withLocalSession } = await import("./lib/local-session.ts");
  let status: LoginStatus = { authenticated: false, profileAccessible: false, manualVerificationRequired: false };
  await withLocalSession(async (context, signal) => {
    const page = context.pages()[0] ?? await context.newPage();
    status = await runLoginFlow(page, signal, credentials, async (verificationRequired) => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await terminal.question(
          verificationRequired
            ? 'Complete verification manually in Chrome. After reaching your dashboard, type "done" (anything else cancels): '
            : 'Complete login manually in Chrome; do not save your password. After reaching your dashboard, type "done" (anything else cancels): ',
          { signal },
        )).trim().toLowerCase() === "done";
      } finally {
        terminal.close();
      }
    });
  });
  console.log(JSON.stringify(status));
  if (!status.authenticated && !process.exitCode) process.exitCode = 1;
}

main().catch(() => {
  // Never expose raw Playwright errors: fill errors can contain credential values.
  console.log(JSON.stringify({ authenticated: false, profileAccessible: false, manualVerificationRequired: false }));
  process.exitCode = 1;
});
