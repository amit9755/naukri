import { inspectSession, reportSessionError, withLocalSession } from "./lib/local-session.ts";

let stage = "launch";
withLocalSession(async (context) => {
  stage = "navigation";
  const page = context.pages()[0] ?? await context.newPage();
  const response = await page.goto("https://www.naukri.com/mnjuser/profile?action=modalOpen", {
    waitUntil: "domcontentloaded", timeout: 25_000,
  });
  const session = await inspectSession(page, response?.status() ?? null);
  if (session.outcome === "BLOCKED" || session.loginRequired) {
    console.log(JSON.stringify(session));
    return;
  }
  stage = "inspection";
  const edit = page.locator(".hdn > em.icon.edit");
  await edit.waitFor({ state: "visible", timeout: 10_000 });
  if (await edit.count() !== 1) throw new Error("Ambiguous basic-details control");
  await edit.click();
  await page.getByText("Basic details", { exact: true }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  console.log(JSON.stringify({ stage, session, path: new URL(page.url()).pathname }));
  console.log(JSON.stringify(await page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    return {
      editControls: Array.from(document.querySelectorAll('[class*="edit"], [aria-label*="Edit"], [title*="Edit"]')).filter(visible).map((element) => ({
        tag: element.tagName, id: element.id, className: element.className,
        role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"), parentClass: element.parentElement?.className,
      })),
      inputs: Array.from(document.querySelectorAll("input")).filter(visible).map((input) => ({
        id: input.id, name: input.name, type: input.type,
        labels: Array.from(input.labels ?? []).map((label) => label.textContent?.trim()),
        placeholder: input.placeholder,
      })),
      buttons: Array.from(document.querySelectorAll("button")).filter(visible).map((button) => ({
        text: button.textContent?.trim(), id: button.id, type: button.type,
      })),
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], form')).filter(visible).map((element) => ({
        tag: element.tagName, id: element.id, role: element.getAttribute("role"),
      })),
    };
  }), null, 2));
}).catch((error: unknown) => {
  console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "Unknown" }));
  reportSessionError();
});
