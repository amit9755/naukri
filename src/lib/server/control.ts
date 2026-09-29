import { createHash, timingSafeEqual } from "node:crypto";
import { completion, exactKeys, record, uuid, online, safeResult, errorCodes } from "../../../lib/automation/contracts.ts";
import type { Config } from "../../../lib/automation/contracts.ts";
import { validSchedule, validScheduleDate, nextRun } from "../../../lib/automation/schedule.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new ApiError(503, "SERVER_NOT_CONFIGURED");
  return value;
}
export function secretHash(secret: string) { return createHash("sha256").update(secret).digest("hex"); }
export function equalSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(secretHash(a)), Buffer.from(secretHash(b))); }
export function bearer(request: Request) {
  const match = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new ApiError(401, "UNAUTHORIZED");
  return match[1];
}
export function originCheck(request: Request) {
  if (request.headers.get("origin") !== new URL(required("APP_ORIGIN")).origin) throw new ApiError(403, "FORBIDDEN");
}
export async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(400, "INVALID_BODY");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_BODY");
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 16_384) { await reader.cancel(); throw new ApiError(413, "BODY_TOO_LARGE"); }
    chunks.push(part.value);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new ApiError(400, "INVALID_BODY"); }
}
export async function supabase(path: string, init: RequestInit = {}) {
  const base = new URL(required("SUPABASE_URL"));
  if (base.protocol !== "https:") throw new ApiError(503, "SERVER_NOT_CONFIGURED");
  const response = await fetch(new URL(path, base), { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { apikey: required("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json", ...init.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.code === "23505" ? 409 : response.status === 401 || response.status === 403 ? 401 : 503,
      data.code === "23505" ? "ACTIVE_COMMAND_EXISTS" : "SERVICE_UNAVAILABLE");
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
export function cookie(request: Request, name: string) {
  const found = request.headers.get("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`));
  return found?.slice(name.length + 1) ?? "";
}
export async function dashboardUser(request: Request): Promise<string> {
  const token = cookie(request, "naukri_access");
  if (!token) throw new ApiError(401, "UNAUTHORIZED");
  const user = await supabase("/auth/v1/user", { headers: { Authorization: `Bearer ${token}` } });
  if (user.id !== required("DASHBOARD_USER_ID")) throw new ApiError(403, "FORBIDDEN");
  return user.id;
}
export async function agentUser(request: Request): Promise<string> {
  const id = request.headers.get("x-agent-id");
  if (!uuid(id)) throw new ApiError(401, "UNAUTHORIZED");
  const token = bearer(request);
  const rows = await supabase(`/rest/v1/agents?id=eq.${id}&select=id,secret_hash`);
  if (!rows[0] || !equalSecret(rows[0].secret_hash, secretHash(token))) throw new ApiError(401, "UNAUTHORIZED");
  return id;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export const defaultControlDependencies = { db: supabase, dashboardUser, agentUser, originCheck };
export async function handleControl(request: Request, path: string, deps = defaultControlDependencies): Promise<Response> {
  try {
    const rpc = (name: string, value: unknown) => deps.db(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(value) });
    if (path === "agent/register" && request.method === "POST") {
      if (!equalSecret(bearer(request), required("AGENT_ENROLLMENT_SECRET")) || required("AGENT_ENROLLMENT_SECRET").length < 32) throw new ApiError(401, "UNAUTHORIZED");
      const value = await body(request); exactKeys(value, ["id", "machine_id", "name", "secret", "app_version"]);
      if (!uuid(value.id) || !uuid(value.machine_id) || typeof value.name !== "string" || !/^[a-zA-Z0-9 _-]{1,80}$/.test(value.name) ||
        typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || value.app_version !== "1.0.0") throw new ApiError(400, "INVALID_BODY");
      await rpc("register_agent", { p_id: value.id, p_owner: required("DASHBOARD_USER_ID"), p_machine: value.machine_id, p_name: value.name, p_hash: secretHash(value.secret), p_version: value.app_version });
      return json({ registered: true, agentId: value.id });
    }
    if (path.startsWith("agent/")) {
      const id = await deps.agentUser(request);
      const value = await body(request);
      if (path === "agent/heartbeat" && request.method === "POST") {
        exactKeys(value, ["app_version"]); if (value.app_version !== "1.0.0") throw new ApiError(400, "INVALID_BODY");
        await deps.db(`/rest/v1/agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: "ONLINE", app_version: value.app_version }) });
        const config = await deps.db(`/rest/v1/automation_config?agent_id=eq.${id}&select=*`);
        return json({ config: config[0] });
      }
      if (path === "agent/commands/claim" && request.method === "POST") {
        exactKeys(value, ["claimKey", "scheduledDate"]);
        if (!uuid(value.claimKey) || (value.scheduledDate !== null && !validScheduleDate(value.scheduledDate))) throw new ApiError(400, "INVALID_BODY");
        await rpc("reconcile_stale", { p_agent: id });
        const commands = await rpc("claim_refresh", { p_agent: id, p_key: value.claimKey, p_day: value.scheduledDate });
        return json({ command: commands[0] ?? null });
      }
      const completeMatch = /^agent\/commands\/([0-9a-f-]+)\/complete$/.exec(path);
      if (completeMatch && request.method === "POST" && uuid(completeMatch[1])) {
        const done = completion(value);
        await rpc("complete_refresh", { p_agent: id, p_command: completeMatch[1], p_status: done.status, p_result: done.result, p_error: done.error_code });
        return json({ completed: true });
      }
      if (path === "agent/rotate" && request.method === "POST") {
        exactKeys(value, ["secret"]);
        if (typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) throw new ApiError(400, "INVALID_BODY");
        await deps.db(`/rest/v1/agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ secret_hash: secretHash(value.secret), updated_at: new Date().toISOString() }) });
        return json({ rotated: true });
      }
      throw new ApiError(404, "NOT_FOUND");
    }
    const owner = await deps.dashboardUser(request);
    if (request.method !== "GET") deps.originCheck(request);
    if (path === "dashboard/status" && request.method === "GET") {
      const agents = await deps.db(`/rest/v1/agents?owner_id=eq.${owner}&select=id,name,status,session_status,last_seen_at,app_version&order=created_at.asc`);
      const results = [];
      for (const agent of agents) {
        await rpc("reconcile_stale", { p_agent: agent.id });
        const [configs, runs, commands] = await Promise.all([
          deps.db(`/rest/v1/automation_config?agent_id=eq.${agent.id}&select=*`),
          deps.db(`/rest/v1/automation_runs?agent_id=eq.${agent.id}&select=id,source,status,started_at,finished_at,result,error_code&order=started_at.desc&limit=30`),
          deps.db(`/rest/v1/automation_commands?agent_id=eq.${agent.id}&status=in.(PENDING,RUNNING)&select=id,status,source,created_at&limit=1`),
        ]);
        const config = configs[0] as Config;
        results.push({ id: agent.id, name: agent.name, status: agent.status, session_status: agent.session_status,
          last_seen_at: agent.last_seen_at, app_version: agent.app_version, online: online(agent.last_seen_at),
          config: { agent_id: config.agent_id, enabled: config.enabled, schedule_time: config.schedule_time, timezone: config.timezone, catch_up: config.catch_up, last_scheduled_date: config.last_scheduled_date, account_label: "Configured locally on Windows" },
          nextRun: nextRun(config), runs: runs.map((run: { id: string; source: string; status: string; started_at: string; finished_at: string | null; result: unknown; error_code: string | null }) => ({
            id: run.id, source: run.source, status: run.status, started_at: run.started_at, finished_at: run.finished_at,
            result: run.result ? safeResult(run.result) : null, error_code: errorCodes.find((code) => code === run.error_code) ?? null,
          })), activeCommand: commands[0] ? { id: commands[0].id, status: commands[0].status, source: commands[0].source } : null });
      }
      return json({ agents: results });
    }
    const value = await body(request);
    if (!uuid(value.agent_id)) throw new ApiError(400, "INVALID_BODY");
    const owned = await deps.db(`/rest/v1/agents?id=eq.${value.agent_id}&owner_id=eq.${owner}&select=id`);
    if (!owned[0]) throw new ApiError(403, "FORBIDDEN");
    if (path === "automation/run" && request.method === "POST") {
      exactKeys(value, ["agent_id"]);
      const command = await rpc("enqueue_refresh", { p_agent: value.agent_id });
      return json({ command }, 202);
    }
    if (path === "automation/config" && request.method === "PUT") {
      exactKeys(value, ["agent_id", "enabled", "schedule_time", "timezone", "catch_up"]);
      if (typeof value.enabled !== "boolean" || typeof value.catch_up !== "boolean" || !validSchedule(value.schedule_time, value.timezone)) throw new ApiError(400, "INVALID_BODY");
      await deps.db(`/rest/v1/automation_config?agent_id=eq.${value.agent_id}`, { method: "PATCH", body: JSON.stringify({ enabled: value.enabled, schedule_time: value.schedule_time, timezone: value.timezone, catch_up: value.catch_up, updated_at: new Date().toISOString() }) });
      return json({ updated: true });
    }
    throw new ApiError(404, "NOT_FOUND");
  } catch (error) {
    const invalid = error instanceof Error && error.message === "INVALID_BODY";
    return json({ error: error instanceof ApiError ? error.message : invalid ? "INVALID_BODY" : "SERVICE_UNAVAILABLE" }, error instanceof ApiError ? error.status : invalid ? 400 : 503);
  }
}
