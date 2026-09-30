import { access, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentDirectory, loadIdentity, atomicJson, acquireAgentLock, localLog, readJournal, writeJournal, serverOrigin } from "./agent/storage.ts";
import { AgentClient, backoff } from "./agent/client.ts";
import { AgentWorker } from "./agent/worker.ts";
import { executeRefresh } from "./agent/executor.ts";
import { assertOutsideRepository } from "./lib/local-chrome.ts";
import type { Config } from "../lib/automation/contracts.ts";

import { startupDiagnostic } from "./agent/startup-diagnostics.ts";
import type { StartupStage } from "./agent/startup-diagnostics.ts";

let startupStage: StartupStage = "local";
async function main() {
  if (process.platform !== "win32" || process.env.VERCEL || process.env.DEBUG || process.env.PWDEBUG) throw new Error("LOCAL_WINDOWS_REQUIRED");
  delete process.env.NAUKRI_USERNAME; delete process.env.NAUKRI_PASSWORD;
  const directory = agentDirectory();
  await assertOutsideRepository(directory);
  const release = await acquireAgentLock(directory);
  const stop = new AbortController();
  const stopWatcher = setInterval(() => { void access(join(directory, "agent.stop")).then(() => stop.abort()).catch(() => {}); }, 2_000);
  const onStop = () => stop.abort();
  process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
  const sleep = (ms: number) => delay(ms, undefined, { signal: stop.signal }).catch(() => {});
  try {
    await unlink(join(directory, "agent.stop")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    startupStage = "origin";
    const server = serverOrigin(process.env.AGENT_SERVER_URL ?? "");
    startupStage = "identity";
    const identity = await loadIdentity(directory, server);
    const client = new AgentClient(identity);
    if (!identity.registered) {
      startupStage = "enrollment";
      const enrollment = process.env.AGENT_ENROLLMENT_SECRET;
      if (!enrollment || enrollment.length < 32) throw new Error("ENROLLMENT_REQUIRED");
      startupStage = "registration";
      await client.request("register", { id: identity.id, machine_id: identity.machine_id, name: process.env.AGENT_NAME ?? "Windows laptop", secret: identity.secret, app_version: "1.0.0" }, enrollment);
      startupStage = "identity";
      identity.registered = true; await atomicJson(join(directory, "agent.json"), identity);
      await localLog(directory, "registered");
    }
    startupStage = "running";
    delete process.env.AGENT_ENROLLMENT_SECRET;
    if (process.argv.includes("--rotate-secret") || identity.pendingSecret) {
      identity.pendingSecret ??= randomBytes(32).toString("base64url");
      await atomicJson(join(directory, "agent.json"), identity);
      try { await client.request("heartbeat", { app_version: "1.0.0" }, identity.pendingSecret); }
      catch { await client.request("rotate", { secret: identity.pendingSecret }); }
      identity.secret = identity.pendingSecret; delete identity.pendingSecret;
      await atomicJson(join(directory, "agent.json"), identity); await localLog(directory, "secret-rotated");
      if (process.argv.includes("--rotate-secret")) return;
    }
    let config: Config | undefined;
    let configReceivedAt = 0;
    const worker = new AgentWorker({ request: (path, body) => client.request(path, body), read: () => readJournal(directory), write: (journal) => writeJournal(directory, journal), execute: executeRefresh,
      log: (event, details) => localLog(directory, event, details) });
    await localLog(directory, "started");
    const heartbeat = async () => {
      while (!stop.signal.aborted) {
        try { const response = await client.request("heartbeat", { app_version: "1.0.0" }); config = response.config; configReceivedAt = Date.now(); }
        catch { await localLog(directory, "heartbeat-failed"); }
        await sleep(60_000);
      }
    };
    const poll = async () => {
      let failures = 0;
      while (!stop.signal.aborted) {
        try {
          if (config && Date.now() - configReceivedAt < 120_000) await worker.tick(config);
          failures = 0;
        } catch { failures++; await localLog(directory, "poll-failed"); }
        await sleep(backoff(failures));
      }
    };
    // During a refresh the independent heartbeat continues. No inbound listener.
    const loops = [heartbeat(), poll()];
    try { await Promise.all(loops); }
    finally { stop.abort(); await Promise.allSettled(loops); }
    await localLog(directory, "stopped");
  } finally {
    clearInterval(stopWatcher);
    process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop);
    await release();
  }
}
main().catch(async (error: unknown) => {
  // No raw errors or environment values, including failures before authentication.
  try { await localLog(agentDirectory(), "startup-failed"); } catch { /* fixed console result below */ }
  console.error(JSON.stringify(startupDiagnostic(error, startupStage)));
  process.exitCode = 1;
});
