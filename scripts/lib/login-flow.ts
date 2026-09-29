import type { Page } from "playwright-core";
import { inspectSession, navigateToDashboard } from "./local-session.ts";

import { checkExistingSession } from "./existing-session.ts";
import type { ExistingSessionStage, DashboardNavigation } from "./existing-session.ts";
import type { SessionErrorCategory } from "./session-diagnostics.ts";

export type LoginCredentials = { username: string; password: string };
export type LoginStage = "launch" | "navigation" | ExistingSessionStage | "login-page-detection" |
  "username-field-detection" | "password-field-detection" | "credential-fill" |
  "submit-button-detection" | "submit" | "post-submit-navigation" | "authentication-check" | "manual-verification";
export type LoginStatus = {
  existingSessionAuthenticated?: boolean;
  errorCategory?: SessionErrorCategory;
  authenticated: boolean;
  profileAccessible: boolean;
  manualVerificationRequired: boolean;
  credentialsConfigured: boolean;
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
    if (existing.existingSessionAuthenticated !== false) return result(existing.reason);

    mark("navigation", "opening official login page");
    const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (signal.aborted) return result("operation cancelled");
    mark("login-page-detection", "checking official login page");
    if (!officialPage(page)) return result("unexpected page origin");
    let state = await observe(response?.status() ?? null);
    if (state.accessDenied) return result("access denied");
    if (challenge(state)) {
      diagnostic.manualVerificationRequired = true;
      return await finishManually("verification challenge requires manual completion");
    }
    if (!response?.ok()) return result("login page response unsuccessful");
    if (state.authenticated) return result("existing session authenticated", true);
    if (new URL(page.url()).pathname !== "/nlogin/login") return result("expected login page not found");
    if (!credentials) return await finishManually("credentials not configured; manual login required");

    // Visible semantic matches only. Found means exactly one candidate was found.
    const usernameName = /^(?:Email ID\s*\/\s*Username|Email ID|Username|Enter your active Email ID\s*\/\s*Username)$/i;
    const passwordName = /^(?:Password|Enter your password)$/i;
    mark("username-field-detection", "checking username field");
    const username = page.getByLabel(usernameName).or(page.getByPlaceholder(usernameName)).filter({ visible: true });
    const usernameCount = await username.count();
    diagnostic.usernameFieldFound = usernameCount === 1;
    mark("password-field-detection", "checking password field");
    const password = page.getByLabel(passwordName).or(page.getByPlaceholder(passwordName)).filter({ visible: true });
    const passwordCount = await password.count();
    diagnostic.passwordFieldFound = passwordCount === 1;
    mark("submit-button-detection", "checking Login button");
    const login = page.getByRole("button", { name: /^Login$/i }).filter({ visible: true });
    const submitCount = await login.count();
    diagnostic.submitButtonFound = submitCount === 1;

    mark("username-field-detection", "checking username field");
    if (!diagnostic.usernameFieldFound) return result(usernameCount === 0 ? "expected login field not found" : "expected login field is ambiguous");
    if (!await username.isEditable()) return result("expected login field is not editable");
    if (!await username.evaluate((element) => element instanceof HTMLInputElement && ["text", "email"].includes(element.type))) return result("unexpected login field type");
    mark("password-field-detection", "checking password field");
    if (!diagnostic.passwordFieldFound) return result(passwordCount === 0 ? "expected login field not found" : "expected login field is ambiguous");
    if (!await password.isEditable()) return result("expected login field is not editable");
    if (!await password.evaluate((element) => element instanceof HTMLInputElement && element.type === "password")) return result("unexpected login field type");
    mark("submit-button-detection", "checking Login button");
    if (!diagnostic.submitButtonFound) return result(submitCount === 0 ? "expected Login button not found" : "expected Login button is ambiguous");
    if (!await login.isEnabled()) return result("Login button is disabled");

    // Recheck origin and challenges immediately before every credential interaction.
    const unsafeReason = async (): Promise<string | null> => {
      if (signal.aborted) return "operation cancelled";
      if (!officialPage(page) || new URL(page.url()).pathname !== "/nlogin/login") return "login page changed before interaction";
      const current = await inspect(page, null);
      diagnostic.manualVerificationRequired ||= challenge(current);
      if (current.accessDenied) return "access denied";
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
