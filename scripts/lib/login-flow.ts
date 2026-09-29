import type { Page } from "playwright-core";
import { inspectSession, navigateToDashboard } from "./local-session.ts";

import { discoverLoginForm, trustedLoginFrame } from "./login-discovery.ts";
import type { LoginStructure } from "./login-discovery.ts";
import { checkExistingSession } from "./existing-session.ts";
import type { ExistingSessionStage, DashboardNavigation } from "./existing-session.ts";
import type { SessionErrorCategory } from "./session-diagnostics.ts";

export type LoginCredentials = { username: string; password: string };
export type LoginStage = "launch" | "navigation" | ExistingSessionStage | "login-page-detection" |
  "username-field-detection" | "password-field-detection" | "credential-fill" |
  "submit-button-detection" | "submit" | "post-submit-navigation" | "authentication-check" | "manual-verification";
export type LoginStatus = Partial<LoginStructure> & {
  existingSessionAuthenticated?: boolean;
  errorCategory?: SessionErrorCategory;
  authenticated: boolean;
  profileAccessible: boolean;
  manualVerificationRequired: boolean;
  credentialsConfigured: boolean;
  usernameCandidateCount?: number;
  passwordCandidateCount?: number;
  submitCandidateCount?: number;
  usernameFieldFound: boolean;
  passwordFieldFound: boolean;
  submitButtonFound: boolean;
  stage: LoginStage;
  reason: string;
};
const loginUrl = "https://www.naukri.com/nlogin/login";

export function credentialsFromEnvironment(env: Record<string, string | undefined>): LoginCredentials | undefined {
  const username = env.NAUKRI_USERNAME;
  const password = env.NAUKRI_PASSWORD;
  if (!username && !password) return undefined;
  if (!username?.trim() || !password) throw new Error("LOGIN_CONFIGURATION_INCOMPLETE");
  return { username, password };
}

function officialPage(page: Page) {
  const url = new URL(page.url());
  return url.protocol === "https:" && url.hostname === "www.naukri.com";
}

// All diagnostic text is fixed here. Never forward errors, URLs, DOM text or values.
// Dependencies permit tests with fake pages; tests never launch a browser.
export async function runLoginFlow(
  page: Page,
  signal: AbortSignal,
  credentials: LoginCredentials | undefined,
  manualCompletion: (verificationRequired: boolean, diagnostic: LoginStatus) => Promise<boolean>,
  inspect = inspectSession,
  dashboard: DashboardNavigation = navigateToDashboard,
  onDiagnostic: (status: LoginStatus) => void = () => {},
  diagnosticMode = false,
  diagnosticInspection: (status: LoginStatus) => Promise<void> = async () => {},
): Promise<LoginStatus> {
  const diagnostic: LoginStatus = {
    authenticated: false, profileAccessible: false, manualVerificationRequired: false,
    credentialsConfigured: !!credentials, usernameFieldFound: false, passwordFieldFound: false,
    submitButtonFound: false, stage: "navigation", reason: "opening authenticated page",
  };
  const mark = (stage: LoginStage, reason: string) => {
    diagnostic.stage = stage;
    diagnostic.reason = reason;
    onDiagnostic({ ...diagnostic });
  };
  const result = (reason: string, authenticated = false): LoginStatus => {
    diagnostic.authenticated = authenticated;
    diagnostic.profileAccessible = authenticated;
    mark(diagnostic.stage, reason);
    return { ...diagnostic };
  };
  let diagnosticInspectionStarted = false;
  const stopDetection = async (reason: string): Promise<LoginStatus> => {
    const stopped = result(reason);
    if (diagnosticMode && !signal.aborted && !diagnosticInspectionStarted) {
      diagnosticInspectionStarted = true;
      await diagnosticInspection(stopped);
    }
    // Inspection is a close-only pause, never a retry or manual-login trigger.
    return stopped;
  };
  const challenge = (state: Awaited<ReturnType<typeof inspectSession>>) => state.verificationDetected || state.captchaDetected;
  const observe = async (status: number | null) => {
    let state = await inspect(page, status);
    for (let i = 0; i < 6 && state.outcome === "UNKNOWN" && !signal.aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await inspect(page, status);
    }
    return state;
  };
  let manualInspectionStarted = false;
  const finishManually = async (reason: string, stage: LoginStage = "manual-verification"): Promise<LoginStatus> => {
    if (signal.aborted) return result("operation cancelled");
    manualInspectionStarted = true;
    mark(stage, reason);
    // No timeout: keep Chrome open until the user confirms, cancels or closes it.
    if (!await manualCompletion(diagnostic.manualVerificationRequired, { ...diagnostic })) return result(`${reason}; manual inspection cancelled`);
    if (signal.aborted) return result("operation cancelled");
    const current = await inspect(page, null);
    diagnostic.manualVerificationRequired ||= challenge(current);
    if (!officialPage(page)) return result("unexpected page origin");
    if (current.accessDenied) return result("access denied");
    if (challenge(current)) return result("manual verification incomplete");
    mark("authentication-check", "verifying authenticated page after manual completion");
    const navigation = await dashboard(page);
    if (navigation.navigationError) return result("authenticated page navigation failed");
    if (signal.aborted) return result("operation cancelled");
    const state = await observe(navigation.status);
    diagnostic.manualVerificationRequired ||= challenge(state);
    const authenticated = officialPage(page) && !!navigation.status && navigation.status >= 200 && navigation.status < 300 && state.authenticated && !signal.aborted;
    return result(authenticated ? "authentication confirmed" : "authentication not confirmed", authenticated);
  };

  try {
    const existing = await checkExistingSession(page, signal, (check) => mark(check.stage, check.reason), inspect, dashboard);
    diagnostic.stage = existing.stage;
    if (existing.existingSessionAuthenticated !== undefined) diagnostic.existingSessionAuthenticated = existing.existingSessionAuthenticated;
    if (diagnosticMode && existing.errorCategory) diagnostic.errorCategory = existing.errorCategory;
    mark(existing.stage, existing.reason);
    if (existing.existingSessionAuthenticated === true) return result("existing session authenticated", true);
    if (existing.state && challenge(existing.state)) {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("verification challenge requires manual completion");
    }
    if (existing.reason === "access denied") {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("access denied; manual inspection required");
    }
    if (existing.existingSessionAuthenticated !== false) return result(existing.reason);

    mark("navigation", "opening official login page");
    const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (signal.aborted) return result("operation cancelled");
    mark("login-page-detection", "checking official login page");
    if (!officialPage(page)) return result("unexpected page origin");
    let state = await observe(response?.status() ?? null);
    if (state.accessDenied) {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("access denied; manual inspection required");
    }
    if (challenge(state)) {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("verification challenge requires manual completion");
    }
    if (!response?.ok()) return result("login page response unsuccessful");
    if (state.authenticated) return result("existing session authenticated", true);
    if (new URL(page.url()).pathname !== "/nlogin/login") return result("expected login page not found");
    if (!credentials) return await finishManually("credentials not configured; manual login required");

    // This is the same Page navigated above, not an inferred active tab.
    await page.bringToFront();
    mark("username-field-detection", "waiting for login document and discovering frames");
    const discovery = await discoverLoginForm(page);
    Object.assign(diagnostic, discovery.diagnostics);
    const { username, password, login } = discovery.fields;
    const { usernameCandidateCount: usernameCount, passwordCandidateCount: passwordCount, submitCandidateCount: submitCount } = discovery.diagnostics;
    diagnostic.usernameFieldFound = usernameCount === 1;
    diagnostic.passwordFieldFound = passwordCount === 1;
    diagnostic.submitButtonFound = submitCount === 1;
    // Readiness may reveal a challenge after the initial page inspection.
    const readyState = await inspect(page, null);
    if (challenge(readyState) || readyState.accessDenied) {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("verification or access restriction requires manual completion");
    }
    if (discovery.ambiguousFrames) return await stopDetection("multiple possible login frames found");

    mark("username-field-detection", "checking username field");
    if (!diagnostic.usernameFieldFound) return await stopDetection(usernameCount === 0 ? "expected login field not found" : "expected login field is ambiguous");
    if (!await username.isEditable()) return await stopDetection("expected login field is not editable");
    if (!await username.evaluate((element) => element instanceof HTMLInputElement && ["text", "email"].includes(element.type))) return await stopDetection("unexpected login field type");
    mark("password-field-detection", "checking password field");
    if (!diagnostic.passwordFieldFound) return await stopDetection(passwordCount === 0 ? "expected login field not found" : "expected login field is ambiguous");
    if (!await password.isEditable()) return await stopDetection("expected login field is not editable");
    if (!await password.evaluate((element) => element instanceof HTMLInputElement && element.type === "password")) return await stopDetection("unexpected login field type");
    mark("submit-button-detection", "checking Login button");
    if (!diagnostic.submitButtonFound) return await stopDetection(submitCount === 0 ? "expected Login button not found" : "expected Login button is ambiguous");
    if (!await login.isEnabled()) return await stopDetection("Login button is disabled");

    if (!discovery.frame) return await stopDetection("coherent login form not found");
    const detectionFrame = discovery.frame;

    // Recheck origin and challenges immediately before every credential interaction.
    const unsafeReason = async (): Promise<string | null> => {
      if (signal.aborted) return "operation cancelled";
      if (!officialPage(page) || new URL(page.url()).pathname !== "/nlogin/login") return "login page changed before interaction";
      if (!trustedLoginFrame(detectionFrame, page)) return "login frame changed before interaction";
      if (detectionFrame !== page.mainFrame()) {
        const childState = await inspectSession(detectionFrame, null);
        diagnostic.manualVerificationRequired ||= challenge(childState) || childState.accessDenied;
        if (diagnostic.manualVerificationRequired) return "verification challenge requires manual completion";
      }
      const current = await inspect(page, null);
      diagnostic.manualVerificationRequired ||= challenge(current);
      if (current.accessDenied) {
        diagnostic.manualVerificationRequired = true;
        return "access denied; manual inspection required";
      }
      if (diagnostic.manualVerificationRequired) return "verification challenge requires manual completion";
      if (current.authenticated) return "session changed before interaction";
      return null;
    };
    const stopUnsafe = async (reason: string) => diagnostic.manualVerificationRequired ? await finishManually(reason) : result(reason);
    mark("credential-fill", "filling username field");
    let unsafe = await unsafeReason();
    if (unsafe) return await stopUnsafe(unsafe);
    await username.fill(credentials.username, { timeout: 3_000 });
    mark("credential-fill", "filling password field");
    unsafe = await unsafeReason();
    if (unsafe) return await stopUnsafe(unsafe);
    await password.fill(credentials.password, { timeout: 3_000 });
    mark("submit", "submitting login once");
    unsafe = await unsafeReason();
    if (unsafe) return await stopUnsafe(unsafe);
    // Exactly one submission. Never retry, including when a click times out.
    await login.click({ timeout: 3_000 });
    mark("post-submit-navigation", "observing login response");
    for (let i = 0; i < 10 && !signal.aborted; i++) {
      state = await inspect(page, null);
      if (!officialPage(page) || state.accessDenied) return await finishManually("login response requires manual inspection", "post-submit-navigation");
      if (challenge(state)) {
        diagnostic.manualVerificationRequired = true;
        return await finishManually("verification challenge requires manual completion");
      }
      if (state.authenticated) {
        mark("authentication-check", "verifying authenticated page");
        const navigation = await dashboard(page);
        if (signal.aborted) return result("operation cancelled");
        if (navigation.navigationError) return await finishManually("authenticated page navigation failed after submission", "authentication-check");
        state = await observe(navigation.status);
        diagnostic.manualVerificationRequired ||= challenge(state);
        const authenticated = officialPage(page) && !!navigation.status && navigation.status >= 200 && navigation.status < 300 && state.authenticated && !signal.aborted;
        if (authenticated) return result("authentication confirmed", true);
        return await finishManually("authentication not confirmed after submission", diagnostic.stage);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return await finishManually("authentication not confirmed after submission", diagnostic.stage);
  } catch {
    if (["username-field-detection", "password-field-detection", "submit-button-detection"].includes(diagnostic.stage)) {
      try {
        return await stopDetection("operation failed at this stage");
      } catch { /* Closed/cancelled inspection still returns only sanitized status. */ }
    }
    // A submission may have reached the server even if Playwright reports failure.
    // Keep the window available for inspection, without resubmitting anything.
    if (!manualInspectionStarted && !signal.aborted && ["submit", "post-submit-navigation", "authentication-check"].includes(diagnostic.stage)) {
      const failedStage = diagnostic.stage;
      try {
        return await finishManually("operation failed at this stage; manual inspection required", failedStage);
      } catch {
        diagnostic.stage = failedStage;
      }
    }
    // Raw fill/navigation errors may contain secrets. Only fixed diagnostics escape.
    return result(signal.aborted ? "operation cancelled" : "operation failed at this stage");
  }
}
