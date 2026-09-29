import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { completion, failed, safeResult } from "../../lib/automation/contracts.ts";
import type { Completion } from "../../lib/automation/contracts.ts";

export function parseRefreshOutput(lines: string[], exitCode: number | null): Completion {
  let last: Record<string, unknown> | undefined;
  for (const line of lines) {
    try { const value = JSON.parse(line); if (typeof value?.success === "boolean") last = value; } catch { /* discard human-readable messages */ }
  }
  if (!last) return failed("INVALID_RESULT", true);
  const safe = safeResult(last);
  if (exitCode === 0 && safe.success) {
    try { return completion({ status: "SUCCESS", result: safe, error_code: null }); } catch { return failed("INVALID_RESULT", safe.saveAttempted); }
  }
  return { ...failed(last.errorCode === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "REFRESH_FAILED", safe.saveAttempted), result: { ...safe, success: false } };
}
export async function executeRefresh(command: string): Promise<Completion> {
  if (command !== "RUN_REFRESH") throw new Error("COMMAND_NOT_ALLOWED");
  const script = fileURLToPath(new URL("../refresh-naukri-name.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(NAUKRI_|SUPABASE_|AGENT_|NEXT_PUBLIC_|DEBUG$|PWDEBUG$|NODE_OPTIONS$)/.test(key)) delete env[key];
  // Fixed executable and arguments only. No server-supplied shell, flags, or path.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--save"], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < 65_536) output += chunk.toString("utf8").slice(0, 65_536 - output.length); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", () => resolve(failed("CHROME_FAILED")));
    child.once("close", (code) => resolve(parseRefreshOutput(output.split(/\r?\n/), code)));
    // Never force-kill Chrome or retry saves. All browser actions retain their
    // existing timeouts; agent shutdown waits for this child to close normally.
  });
}
