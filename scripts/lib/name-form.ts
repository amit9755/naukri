import type { Page } from "playwright-core";
import { inspectSession } from "./local-session.ts";

// Observed in the live signed-in profile on 2026-09-24; no guessed selectors.
export const nameSelectors = {
  edit: ".hdn > em.icon.edit",
  form: "#editBasicDetailsForm",
  input: "input#name",
};
export const profileUrl = "https://www.naukri.com/mnjuser/profile";

export async function checkAccess(page: Page, status: number | null = null) {
  const result = await inspectSession(page, status);
  if (result.outcome === "BLOCKED" || result.loginRequired || !result.evidence.accountRoute) {
    throw new Error("ACCESS_CHECK_FAILED");
  }
}

export async function openNameForm(page: Page) {
  await checkAccess(page);
  const edit = page.locator(nameSelectors.edit);
  await edit.waitFor({ state: "visible", timeout: 10_000 });
  if (await edit.count() !== 1) throw new Error("AMBIGUOUS_EDIT_CONTROL");
  await edit.click();
  const form = page.locator(nameSelectors.form);
  await form.waitFor({ state: "visible", timeout: 10_000 });
  const name = form.locator(nameSelectors.input);
  if (await name.count() !== 1 || !await name.isEditable()) throw new Error("NAME_NOT_EDITABLE");
  return { form, name, save: form.getByRole("button", { name: "Save", exact: true }) };
}
