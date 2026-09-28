import { inspectSession, navigateToDashboard, reportSessionError, withLocalSession } from "./lib/local-session.ts";

withLocalSession(async (context, signal) => {
  const page = context.pages()[0] ?? await context.newPage();
  const navigation = await navigateToDashboard(page);
  let result = await inspectSession(page, navigation.status);
  // A brief observation window for client rendering, not a navigation retry.
  for (let i = 0; i < 6 && result.outcome === "UNKNOWN" && !navigation.navigationError && !signal.aborted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await inspectSession(page, navigation.status);
  }
  if (navigation.navigationError) {
    result.authenticated = false;
    result.profileAccessible = false;
    if (result.outcome === "AUTHENTICATED") result.outcome = "UNKNOWN";
  }
  console.log(JSON.stringify({ ...result, ...navigation }, null, 2));
}).catch(reportSessionError);
