// Retired server browser entry point. Browser automation exists only in scripts/.
export async function launchBrowser(): Promise<never> {
  throw new Error("Browser execution is local-only");
}
