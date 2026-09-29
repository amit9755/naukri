import type { Page } from "playwright-core";

// Semantic cues are combined, not tried as ordered fallbacks: separate matches
// remain ambiguous. Locator unions deduplicate a single input matching many cues.
const usernameName = /\b(?:e-?mail(?:\s*(?:id|address))?|user[\s_-]*name)\b/i;
const passwordName = /\bpassword\b/i;
const usernameIdentifiers = [
  "email", "emailid", "email-id", "email_id", "emailaddress", "email-address", "email_address",
  "username", "user-name", "user_name", "loginemail", "login-email", "login_email",
  "loginusername", "login-username", "login_username",
];

export function loginFieldCandidates(page: Page) {
  const textInputs = page.locator('input:not([type]), input[type="text" i], input[type="email" i]');
  const namedInputs = page.locator(usernameIdentifiers.flatMap((name) =>
    [`input[name="${name}" i]`, `input[id="${name}" i]`]).join(", "));
  const username = page.getByLabel(usernameName)
    .or(page.getByPlaceholder(usernameName))
    .or(page.getByRole("textbox", { name: usernameName }))
    .or(page.locator('input[type="email" i]'))
    .or(namedInputs)
    .and(textInputs)
    .filter({ visible: true });
  const passwordInputs = page.locator('input[type="password" i]');
  const password = page.getByLabel(passwordName)
    .or(page.getByRole("textbox", { name: passwordName }))
    .or(passwordInputs)
    .and(passwordInputs)
    .filter({ visible: true });
  const login = page.getByRole("button", { name: /^\s*log\s*in\s*$/i }).filter({ visible: true });
  return { username, password, login };
}
