import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { localChromePaths } from "../lib/local-chrome.ts";
import { completion, record, uuid, safeResult, errorCodes } from "../../lib/automation/contracts.ts";
import type { Command, Completion } from "../../lib/automation/contracts.ts";

export type Identity = { id: string; machine_id: string; secret: string; server: string; registered: boolean; pendingSecret?: string };
export type Journal = { claimKey: string; scheduledDate: string | null; phase: "claiming" | "started" | "completed"; command?: Command; completion?: Completion };
export function agentDirectory() { return join(localChromePaths().profileDirectory, ".."); }
export function serverOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("INVALID_SERVER_ORIGIN");
  return url.origin;
}
export async function atomicJson(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}
export async function loadIdentity(directory: string, server: string): Promise<Identity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "agent.json");
  try {
    const value = record(JSON.parse(await readFile(path, "utf8")));
    if (!uuid(value.id) || !uuid(value.machine_id) || typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || value.server !== server || typeof value.registered !== "boolean" ||
      (value.pendingSecret !== undefined && (typeof value.pendingSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.pendingSecret)))) throw new Error("INVALID_IDENTITY");
    return value as Identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("IDENTITY_UNAVAILABLE");
    const identity: Identity = { id: randomUUID(), machine_id: randomUUID(), secret: randomBytes(32).toString("base64url"), server, registered: false };
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(identity)); await handle.sync(); } finally { await handle.close(); }
    return identity;
  }
}
export async function readJournal(directory: string): Promise<Journal | null> {
  try {
    const value = record(JSON.parse(await readFile(join(directory, "agent-state.json"), "utf8")));
    if (!uuid(value.claimKey) || !["claiming", "started", "completed"].includes(String(value.phase))) throw new Error();
    if (value.phase !== "claiming") {
      const command = record(value.command);
      if (!uuid(command.id) || command.command !== "RUN_REFRESH") throw new Error();
    }
    if (value.phase === "completed") completion(value.completion);
    return value as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("JOURNAL_UNAVAILABLE");
  }
}
export async function writeJournal(directory: string, value: Journal | null) {
  if (value) await atomicJson(join(directory, "agent-state.json"), value);
  else await unlink(join(directory, "agent-state.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
export async function acquireAgentLock(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "agent.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      return async () => { await unlink(path); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt) throw new Error("AGENT_ALREADY_RUNNING");
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("LOCK_REQUIRES_INSPECTION");
      try { process.kill(pid, 0); throw new Error("AGENT_ALREADY_RUNNING"); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("AGENT_ALREADY_RUNNING");
        // Only reclaim a dead process lock, never an active browser/profile lock.
        await unlink(path);
      }
    }
  }
  throw new Error("AGENT_ALREADY_RUNNING");
}
export async function localLog(directory: string, event: string, details: { commandId?: string; source?: string; status?: string; result?: unknown; errorCode?: string | null } = {}) {
  const allowed = ["started", "stopped", "heartbeat-failed", "poll-failed", "registered", "run-finished", "run-started", "startup-failed", "secret-rotated"];
  if (!allowed.includes(event)) return;
  const logs = join(directory, "logs"); await mkdir(logs, { recursive: true, mode: 0o700 });
  const path = join(logs, "agent.log");
  if ((await stat(path).catch(() => null))?.size && (await stat(path)).size > 1_000_000) {
    await unlink(`${path}.1`).catch(() => {}); await rename(path, `${path}.1`).catch(() => {});
  }
  let result;
  try { if (details.result) result = safeResult(details.result); } catch { /* discard invalid data */ }
  const safe = {
    timestamp: new Date().toISOString(), event,
    ...(result ? { result } : {}),
    ...(errorCodes.some((code) => code === details.errorCode) ? { errorCode: details.errorCode } : {}),
    ...(uuid(details.commandId) ? { commandId: details.commandId } : {}),
    ...(["MANUAL", "SCHEDULED"].includes(details.source ?? "") ? { source: details.source } : {}),
    ...(["RUNNING", "SUCCESS", "FAILED", "AUTH_REQUIRED"].includes(details.status ?? "") ? { status: details.status } : {}),
  };
  const handle = await open(path, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(safe)}\n`); } finally { await handle.close(); }
}
