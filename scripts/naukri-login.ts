import { createInterface } from "node:readline/promises";
import type { LoginStatus } from "./lib/login-flow.ts";

let status: LoginStatus = {
  authenticated: false, profileAccessible: false, manualVerificationRequired: false,
  credentialsConfigured: !!process.env.NAUKRI_USERNAME?.trim() && !!process.env.NAUKRI_PASSWORD,
  usernameFieldFound: false, passwordFieldFound: false, submitButtonFound: false,
  stage: "launch", reason: "login setup failed",
};
let flowFinished = false;
const diagnosticMode = process.env.NAUKRI_DIAGNOSTIC === "true";

async function main() {
  console.log(JSON.stringify({ credentialsConfigured: status.credentialsConfigured }));
  // Playwright API debugging can include fill values. Refuse before importing it.
  if (process.env.DEBUG || process.env.PWDEBUG) {
    status.reason = "debug logging must be disabled for credential privacy";
    throw new Error();
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    status.reason = "interactive terminal required";
    throw new Error();
  }
  const { credentialsFromEnvironment, runLoginFlow } = await import("./lib/login-flow.ts");
  status.reason = "credential configuration incomplete";
  const credentials = credentialsFromEnvironment(process.env);
  // Keep credentials in this process's memory, not Chrome's inherited environment.
  delete process.env.NAUKRI_USERNAME;
  delete process.env.NAUKRI_PASSWORD;
  status.reason = "local Chrome or dedicated profile initialization failed";
  const { withLocalSession } = await import("./lib/local-session.ts");
  await withLocalSession(async (context, signal) => {
    const page = context.pages()[0] ?? await context.newPage();
    status = await runLoginFlow(page, signal, credentials, async (_verificationRequired, diagnostic) => {
      console.log(JSON.stringify(diagnostic));
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await terminal.question(
          'Inspect Chrome and complete any verification manually. Do not save your password. After reaching your dashboard, type "done" (anything else cancels): ',
          { signal },
        )).trim().toLowerCase() === "done";
      } finally {
        terminal.close();
      }
    }, undefined, undefined, (diagnostic) => {
      status = diagnostic;
      if (diagnosticMode && diagnostic.stage.startsWith("existing-session-")) console.log(JSON.stringify(diagnostic));
    }, diagnosticMode, async (diagnostic) => {
      console.log(JSON.stringify(diagnostic));
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (!signal.aborted) {
          const answer = await terminal.question(
            "Diagnostic stopped. Inspect the visible page, then type done to close. ", { signal },
          );
          if (answer.trim().toLowerCase() === "done") break;
        }
      } finally {
        terminal.close();
      }
    });
    flowFinished = true;
  });
  console.log(JSON.stringify(status));
  if (!status.authenticated && !process.exitCode) process.exitCode = 1;
}

main().catch(() => {
  // Never expose raw Playwright errors: fill errors can contain credential values.
  status = {
    ...status, authenticated: false, profileAccessible: false,
    reason: flowFinished ? "browser session cleanup failed" : status.reason,
  };
  console.log(JSON.stringify(status));
  process.exitCode = 1;
});
