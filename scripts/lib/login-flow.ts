import type { Page } from "playwright-core";
import { inspectSession, navigateToDashboard } from "./local-session.ts";

export type LoginCredentials = { username: string; password: string };
export type LoginStatus = { authenticated: boolean; profileAccessible: boolean; manualVerificationRequired: boolean };
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

// Dependencies permit unit tests with fake pages; tests never launch a browser.
export async function runLoginFlow(
  page: Page,
  signal: AbortSignal,
  credentials: LoginCredentials | undefined,
  manualCompletion: (verificationRequired: boolean) => Promise<boolean>,
  inspect = inspectSession,
  dashboard: (page: Page) => Promise<{ status: number | null; navigationError: string | null }> = navigateToDashboard,
): Promise<LoginStatus> {
  let manualVerificationRequired = false;
  const result = (authenticated = false): LoginStatus => ({ authenticated, profileAccessible: authenticated, manualVerificationRequired });
  const observe = async (status: number | null) => {
    let state = await inspect(page, status);
    for (let i = 0; i < 6 && state.outcome === "UNKNOWN" && !signal.aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await inspect(page, status);
    }
    return state;
  };
  const challenge = (state: Awaited<ReturnType<typeof inspectSession>>) => state.verificationDetected || state.captchaDetected;
  const finishManually = async (): Promise<LoginStatus> => {
    if (signal.aborted || !await manualCompletion(manualVerificationRequired)) return result();
    // Inspect before navigating so an unfinished challenge is left untouched.
    const current = await inspect(page, null);
    if (signal.aborted || current.accessDenied || challenge(current)) return result();
    const navigation = await dashboard(page);
    if (navigation.navigationError || signal.aborted) return result();
    const state = await observe(navigation.status);
    manualVerificationRequired ||= challenge(state);
    return result(officialPage(page) && !!navigation.status && navigation.status >= 200 && navigation.status < 300 && state.authenticated && !signal.aborted);
  };

  const initialNavigation = await dashboard(page);
  if (initialNavigation.navigationError || signal.aborted) return result();
  let state = await observe(initialNavigation.status);
  if (signal.aborted || !officialPage(page) || state.accessDenied) return result();
  if (state.authenticated && initialNavigation.status !== null && initialNavigation.status >= 200 && initialNavigation.status < 300) return result(true);
  if (challenge(state)) {
    manualVerificationRequired = true;
    return finishManually();
  }

  const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
  if (signal.aborted || !officialPage(page)) return result();
  state = await observe(response?.status() ?? null);
  if (state.accessDenied) return result();
  if (challenge(state)) {
    manualVerificationRequired = true;
    return finishManually();
  }
  if (!response?.ok()) return result();
  if (state.authenticated) return result(true);
  if (!credentials) return finishManually();

  // Match visible semantic labels/placeholders only, never positional selectors.
  // Input candidates must be unique and editable; the Login button must be unique.
  const usernameName = /^(?:Email ID\s*\/\s*Username|Email ID|Username|Enter your active Email ID\s*\/\s*Username)$/i;
  const passwordName = /^(?:Password|Enter your password)$/i;
  const username = page.getByLabel(usernameName).or(page.getByPlaceholder(usernameName)).filter({ visible: true });
  const password = page.getByLabel(passwordName).or(page.getByPlaceholder(passwordName)).filter({ visible: true });
  const login = page.getByRole("button", { name: /^Login$/i }).filter({ visible: true });
  if (await username.count() !== 1 || await password.count() !== 1 || await login.count() !== 1) return result();
  if (!await username.isEditable() || !await password.isEditable() || !await login.isEnabled()) return result();
  if (!await username.evaluate((element) => element instanceof HTMLInputElement && ["text", "email"].includes(element.type)) ||
      !await password.evaluate((element) => element instanceof HTMLInputElement && element.type === "password")) return result();

  // Recheck origin and challenges immediately before every credential interaction.
  const safe = async () => {
    if (signal.aborted || !officialPage(page) || new URL(page.url()).pathname !== "/nlogin/login") return false;
    const current = await inspect(page, null);
    manualVerificationRequired ||= challenge(current);
    return !current.authenticated && !current.accessDenied && !manualVerificationRequired;
  };
  if (!await safe()) return manualVerificationRequired ? finishManually() : result();
  await username.fill(credentials.username, { timeout: 3_000 });
  if (!await safe()) return manualVerificationRequired ? finishManually() : result();
  await password.fill(credentials.password, { timeout: 3_000 });
  if (!await safe()) return manualVerificationRequired ? finishManually() : result();
  // Exactly one submission. Never retry, including when a click times out.
  await login.click({ timeout: 3_000 });
  // Observe only after submission; no repeat login request or automatic reload.
  for (let i = 0; i < 10 && !signal.aborted; i++) {
    state = await inspect(page, null);
    if (signal.aborted || !officialPage(page) || state.accessDenied) return result();
    if (challenge(state)) {
      manualVerificationRequired = true;
      return finishManually();
    }
    if (state.authenticated) {
      const navigation = await dashboard(page);
      if (navigation.navigationError || signal.aborted) return result();
      state = await observe(navigation.status);
      if (challenge(state)) {
        manualVerificationRequired = true;
        return finishManually();
      }
      return result(officialPage(page) && !!navigation.status && navigation.status >= 200 && navigation.status < 300 && state.authenticated && !signal.aborted);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return result();
}
