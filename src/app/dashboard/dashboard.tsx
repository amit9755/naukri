"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Config, SafeResult } from "../../../lib/automation/contracts.ts";
type Run = { id: string; source: string; status: string; started_at: string; error_code: string | null; result: SafeResult | null };
type Agent = { id: string; name: string; online: boolean; session_status: string; last_seen_at: string | null; config: Config; nextRun: string | null; runs: Run[]; activeCommand: { id: string; status: string; source: string } | null };
function Badge({ value }: { value: string }) { return <span className={`badge badge-${value.toLowerCase()}`}>{value.replaceAll("_", " ")}</span>; }
function date(value: string | null, zone: string) { return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(value)) : "—"; }
export default function Dashboard() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      let response = await fetch("/api/dashboard/status", { cache: "no-store" });
      if (response.status === 401) {
        const renewed = await fetch("/api/auth/session", { method: "POST" });
        if (!renewed.ok) { router.replace("/login"); return; }
        response = await fetch("/api/dashboard/status", { cache: "no-store" });
      }
      if (!response.ok) throw new Error();
      setAgents((await response.json()).agents); setError("");
    } catch { setError("Status unavailable. Last displayed data may be out of date."); }
    finally { setLoading(false); }
  }, [router]);
  useEffect(() => { const initial = setTimeout(() => void refresh(), 0); const id = setInterval(() => void refresh(), 12_000); return () => { clearTimeout(initial); clearInterval(id); }; }, [refresh]);
  async function mutate(id: string, path: string, method: string, body: unknown) {
    if (busy) return; setBusy(id); setError("");
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 409) { await refresh(); setError("A refresh is already pending or running. Showing the existing operation."); return; }
      if (!response.ok) throw new Error();
      await refresh();
    } catch { setError("Request could not be confirmed. Check status before trying again."); }
    finally { setBusy(null); }
  }
  return <main className="dashboard"><header><div><span className="eyebrow">WINDOWS EXECUTION · PRIVATE CONTROL</span><h1>Naukri Automation</h1><p>Your local Chrome session. One carefully verified refresh.</p></div><button className="secondary" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); }}>Sign out</button></header>
    {error && <div role="alert" className="notice error">{error}</div>}
    {loading && <div className="panel">Loading agent status…</div>}
    {!loading && !agents.length && <div className="panel"><h2>No Windows agent connected</h2><p>Register and start the agent on your Windows laptop to see its status here.</p></div>}
    {agents.map((agent) => <section key={agent.id} className="agent-section"><div className="section-heading"><h2>{agent.name}</h2><Badge value={agent.online ? "ONLINE" : "OFFLINE"} /></div>
      {agent.session_status === "AUTH_REQUIRED" && <div className="notice auth"><strong>Naukri login required on Windows</strong><p>Restore your session locally. No automatic login attempts will be made.</p></div>}
      <div className="grid"><article className="panel"><h3>Windows Agent</h3><p className="big">{agent.online ? "Connected" : "Offline"}</p><p>Last heartbeat</p><strong>{date(agent.last_seen_at, agent.config.timezone)}</strong><p className="muted">{agent.config.account_label}</p></article>
      <article className="panel"><h3>Naukri session</h3><p className="big">{agent.session_status === "SUCCESS" ? "Operational" : agent.session_status === "AUTH_REQUIRED" ? "Login required" : "Unknown"}</p><p>Verified by the last completed refresh.</p>{agent.activeCommand && <p><Badge value={agent.activeCommand.status} /> {agent.activeCommand.source.toLowerCase()}</p>}</article>
      <article className="panel"><h3>Next scheduled run</h3><p className="big small">{date(agent.nextRun, agent.config.timezone)}</p><p>{agent.config.timezone}</p>{!agent.online && agent.config.enabled && <p className="muted">Waiting for Windows. {agent.config.catch_up ? "One catch-up is allowed today." : "Missed runs are skipped."}</p>}<button disabled={!!busy || !!agent.activeCommand} onClick={() => void mutate(agent.id, "/api/automation/run", "POST", { agent_id: agent.id })}>{agent.activeCommand ? "Operation in progress" : "Run now"}</button><p className="muted">Queues one profile save on Windows, even if offline.</p></article></div>
      <div className="grid lower"><article className="panel"><h3>Daily schedule</h3><form key={JSON.stringify(agent.config)} onSubmit={(event) => {
        event.preventDefault(); const values = new FormData(event.currentTarget);
        void mutate(agent.id, "/api/automation/config", "PUT", { agent_id: agent.id, enabled: values.get("enabled") === "on", catch_up: values.get("catch_up") === "on", schedule_time: values.get("schedule_time"), timezone: values.get("timezone") });
      }}><label className="check"><input type="checkbox" name="enabled" defaultChecked={agent.config.enabled} /> Automation enabled</label><div className="form-row"><label>Local time<input name="schedule_time" type="time" required defaultValue={agent.config.schedule_time.slice(0, 5)} /></label><label>Timezone<input name="timezone" required defaultValue={agent.config.timezone} placeholder="Asia/Kolkata" /></label></div><label className="check"><input type="checkbox" name="catch_up" defaultChecked={agent.config.catch_up} /> Catch up once if the laptop starts late</label><button className="secondary" disabled={!!busy}>Save schedule</button></form></article>
      <article className="panel"><h3>Last run</h3>{agent.runs[0] ? <><p className="big small">{date(agent.runs[0].started_at, agent.config.timezone)}</p><Badge value={agent.runs[0].status} /><ul className="facts"><li>Original name preserved: {agent.runs[0].result?.originalNamePreserved === true ? "Yes" : "Not confirmed"}</li><li>Verified after reload: {agent.runs[0].result?.verifiedAfterReload ? "Yes" : "Not confirmed"}</li><li>Refresh timestamp: {agent.runs[0].result?.refreshTimestampVerified ? "Verified" : "Not verified separately"}</li></ul>{agent.runs[0].error_code && <p className="error">{agent.runs[0].error_code}</p>}</> : <p>No runs yet.</p>}</article></div>
      <article className="panel history"><h3>Recent runs</h3><div className="table-scroll"><table><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Details</th></tr></thead><tbody>{agent.runs.map((run) => <tr key={run.id}><td>{date(run.started_at, agent.config.timezone)}</td><td>{run.source}</td><td><Badge value={run.status} /></td><td>{run.error_code ?? (run.result?.verifiedAfterReload ? "Original name verified after reload" : "—")}</td></tr>)}</tbody></table>{!agent.runs.length && <p>No history yet.</p>}</div></article>
    </section>)}<footer>Browser automation runs only on your Windows computer. Last known status refreshes every 12 seconds.</footer></main>;
}
