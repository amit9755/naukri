import type { Page } from "playwright-core";
import { inspectSession, navigateToDashboard } from "./local-session.ts";
import { sessionErrorCategory } from "./session-diagnostics.ts";
import type { SessionErrorCategory } from "./session-diagnostics.ts";

export type ExistingSessionStage = "existing-session-navigation" | "existing-session-response-check" |
  "existing-session-page-check" | "existing-session-auth-detection";
export type ExistingSessionCheck = {
  stage: ExistingSessionStage;
  reason: string;
  existingSessionAuthenticated?: boolean;
  errorCategory?: SessionErrorCategory;
  state?: Awaited<ReturnType<typeof inspectSession>>;
};
export type DashboardNavigation = (page: Page, onError?: (category: SessionErrorCategory) => void) => Promise<{
  status: number | null; navigationError: string | null;
}>;

function loginRedirect(page: Page) {
  const url = new URL(page.url());
  return url.protocol === "https:" && url.hostname === "www.naukri.com" &&
    /^\/(?:nlogin\/login|login|signin|sign-in)\/?$/.test(url.pathname);
}

// A login redirect establishes logged-out state without evaluating the departing
// dashboard document. Actual login-page/challenge checks still happen downstream.
export async function checkExistingSession(
  page: Page,
  signal: AbortSignal,
  report: (check: ExistingSessionCheck) => void = () => {},
  inspect = inspectSession,
  navigate: DashboardNavigation = navigateToDashboard,
): Promise<ExistingSessionCheck> {
  let stage: ExistingSessionStage = "existing-session-navigation";
  const mark = (next: ExistingSessionStage, reason: string) => { stage = next; report({ stage, reason }); };
  const stopped = (reason: string, errorCategory?: SessionErrorCategory): ExistingSessionCheck => ({ stage, reason, ...(errorCategory ? { errorCategory } : {}) });
  const pageUnavailable = () => {
    if (page.context().browser()?.isConnected() === false) return stopped("browser closed during existing-session check", "browser-closed");
    if (page.isClosed()) return stopped("page closed during existing-session check", "page-closed");
    if (signal.aborted) return stopped("operation cancelled");
  };
  try {
    mark("existing-session-navigation", "opening authenticated page");
    const unavailable = pageUnavailable();
    if (unavailable) return unavailable;
    let navigationCategory: SessionErrorCategory | undefined;
    const navigation = await navigate(page, (category) => { navigationCategory = category; });
    const closed = pageUnavailable();
    if (closed) return closed;
    if (navigation.navigationError) return stopped("existing-session navigation failed", navigationCategory ?? (navigation.navigationError === "TIMEOUT" ? "navigation-timeout" : "unknown"));

    mark("existing-session-response-check", "checking existing-session response");
    // Access restrictions stop automation and let the caller offer manual inspection.
    if (navigation.status === 403 || navigation.status === 429) return stopped("access denied", "unexpected-status");
    // 401 is a normal logged-out response; other failures stop.
    if (navigation.status === null || (navigation.status !== 401 && (navigation.status < 200 || navigation.status >= 300))) {
      return stopped("existing-session response unsuccessful", "unexpected-status");
    }
    mark("existing-session-page-check", "checking existing-session page");
    const url = new URL(page.url());
    if (url.protocol !== "https:" || url.hostname !== "www.naukri.com") return stopped("unexpected page origin", "unknown");
    if (loginRedirect(page)) return { stage, reason: "profile redirected to login", existingSessionAuthenticated: false };

    mark("existing-session-auth-detection", "detecting existing-session authentication");
    let state = await inspect(page, navigation.status);
    // Passive observation only. Never repeat navigation or retry a failed evaluate.
    for (let i = 0; i < 6 && state.outcome === "UNKNOWN" && !signal.aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const unavailable = pageUnavailable();
      if (unavailable) return unavailable;
      if (loginRedirect(page)) return { stage, reason: "profile redirected to login", existingSessionAuthenticated: false };
      state = await inspect(page, navigation.status);
    }
    const unavailableAfterDetection = pageUnavailable();
    if (unavailableAfterDetection) return unavailableAfterDetection;
    const finalUrl = new URL(page.url());
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "www.naukri.com") return stopped("unexpected page origin", "unknown");
    if (state.accessDenied) return stopped("access denied", "unexpected-status");
    if (state.captchaDetected || state.verificationDetected) return { stage, reason: "manual verification required", state };
    if (state.authenticated && navigation.status !== 401) return { stage, reason: "existing session authenticated", existingSessionAuthenticated: true, state };
    if (state.loginRequired || navigation.status === 401 || loginRedirect(page)) return { stage, reason: "existing session is unauthenticated", existingSessionAuthenticated: false, state };
    return stopped("existing-session authentication is inconclusive", "unknown");
  } catch (error) {
    const category = sessionErrorCategory(error, page);
    // Client-side logout redirects can destroy the evaluate execution context.
    // Accept only a confirmed official login destination, never other exceptions.
    if (["existing-session-auth-detection"].includes(stage) && category === "navigation-interrupted" && !signal.aborted && loginRedirect(page)) {
      return { stage, reason: "profile redirected to login", existingSessionAuthenticated: false };
    }
    return stopped("existing-session operation failed", category);
  }
}
