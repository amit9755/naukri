import { withLocalSession } from "./lib/local-session.ts";
import { checkAccess, openNameForm, profileUrl } from "./lib/name-form.ts";

// Read-only unless explicitly invoked with --save. Never logs the name or form data.
const saveRequested = process.argv.includes("--save");
let stage = "launch";
let saveAttempted = false;

withLocalSession(async (context) => {
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(10_000);
  stage = "navigation";
  console.log("Step 1: Opening your profile.");
  const response = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await checkAccess(page, response?.status() ?? null);
  if (!response?.ok()) throw new Error("NAVIGATION_FAILED");
  stage = "read_name";
  console.log("Step 2: Clicking the pencil and reading the current name.");
  const { form, name, save } = await openNameForm(page);
  const originalName = await name.inputValue();
  if (!originalName.trim()) throw new Error("EMPTY_ORIGINAL_NAME");
  if (!saveRequested) {
    console.log(JSON.stringify({ success: true, mode: "dry-run", nameFound: true, wouldResaveSameName: true }));
    return;
  }

  // Snapshot all form controls in memory to ensure only the original form values
  // are submitted. Never print them, persist them, or read password/OTP controls.
  const snapshot = () => form.evaluate((element) => Array.from(
    element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"),
  ).map((control) => {
    if (control instanceof HTMLInputElement && /password|hidden|file/.test(control.type)) return null;
    if (/otp|password/i.test(`${control.id} ${control.name}`)) return null;
    return { id: control.id, value: control.value, checked: control instanceof HTMLInputElement ? control.checked : null };
  }));
  const originalForm = JSON.stringify(await snapshot());
  let draftRestored = false;
  try {
    stage = "restore_name_in_form";
    await checkAccess(page);
    console.log("Step 3: Clearing the name in the unsaved form.");
    await name.fill("");
    console.log("Step 4: Restoring the exact original name.");
    await name.fill(originalName);
    draftRestored = await name.inputValue() === originalName;
    if (!draftRestored) throw new Error("DRAFT_MISMATCH");
    await name.blur();
    if (JSON.stringify(await snapshot()) !== originalForm) throw new Error("FORM_VALUES_CHANGED");
    await checkAccess(page);
    if (await name.inputValue() !== originalName) throw new Error("NAME_CHANGED_BEFORE_SAVE");
    stage = "save";
    if (await save.count() !== 1 || !await save.isEnabled()) throw new Error("SAVE_UNAVAILABLE");
    saveAttempted = true;
    console.log("Step 5: Saving once with the original name restored.");
    await save.click();
    await form.waitFor({ state: "hidden", timeout: 15_000 });
    stage = "verify_after_reload";
    console.log("Step 6: Reloading and verifying the saved name.");
    const reloaded = await page.reload({ waitUntil: "domcontentloaded", timeout: 25_000 });
    await checkAccess(page, reloaded?.status() ?? null);
    if (!reloaded?.ok()) throw new Error("RELOAD_FAILED");
    const persisted = await openNameForm(page);
    if (await persisted.name.inputValue() !== originalName) throw new Error("PERSISTED_NAME_MISMATCH");
    console.log(JSON.stringify({
      success: true, mode: "same-name-save", saveAttempted: true,
      originalNamePreserved: true, verifiedAfterReload: true,
      refreshTimestampVerified: false,
    }));
  } finally {
    // If interrupted during editing, restore the unsaved draft if still accessible.
    // Never submit a blank name, retry a save, or interact through a block/challenge.
    if (!draftRestored && !page.isClosed()) {
      try {
        await checkAccess(page);
        if (await name.isVisible() && await name.isEditable()) await name.fill(originalName);
      } catch { /* Closing the context discards an unsaved draft. */ }
    }
  }
}, { slowMo: 700 }).catch(() => {
  console.error(JSON.stringify({
    success: false, stage, saveAttempted,
    originalNamePreserved: null,
    message: "Stopped without retry. Verify your name manually if a save was attempted; no automatic correction was submitted.",
  }));
  process.exitCode = 1;
});
