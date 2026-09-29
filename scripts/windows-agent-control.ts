import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDirectory } from "./agent/storage.ts";
async function main() {
  if (process.platform !== "win32") throw new Error();
  const directory = agentDirectory();
  if (process.argv.includes("--stop")) {
    await writeFile(join(directory, "agent.stop"), "stop", { mode: 0o600 });
    console.log(JSON.stringify({ stopRequested: true, note: "Agent finishes any active refresh and then exits gracefully." }));
    return;
  }
  const pid = Number(await readFile(join(directory, "agent.lock"), "utf8").catch(() => ""));
  let running = false;
  if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); running = true; } catch { /* stopped */ } }
  console.log(JSON.stringify({ running, logs: "%LOCALAPPDATA%\\NaukriAutomation\\logs" }));
}
main().catch(() => { console.error(JSON.stringify({ error: "LOCAL_AGENT_STATUS_UNAVAILABLE" })); process.exitCode = 1; });
