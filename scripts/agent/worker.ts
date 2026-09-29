import { randomUUID } from "node:crypto";
import { completion, failed, uuid } from "../../lib/automation/contracts.ts";
import type { Command, Completion, Config } from "../../lib/automation/contracts.ts";
import { dueDate } from "../../lib/automation/schedule.ts";
import type { Journal } from "./storage.ts";
export type WorkerDependencies = {
  request: (path: string, body: unknown) => Promise<unknown>;
  read: () => Promise<Journal | null>; write: (value: Journal | null) => Promise<void>;
  execute: (command: string) => Promise<Completion>;
  log: (event: string, details: { commandId?: string; source?: string; status?: string; result?: unknown; errorCode?: string | null }) => Promise<void>;
};
export class AgentWorker {
  busy = false;
  deps: WorkerDependencies;
  constructor(deps: WorkerDependencies) { this.deps = deps; }
  async tick(config: Config, now = new Date().toISOString()) {
    if (this.busy) return;
    this.busy = true;
    try {
      let journal = await this.deps.read();
      if (journal?.phase === "started") {
        // Crash after save may have happened. Report uncertainty; never execute again.
        journal = { ...journal, phase: "completed", completion: failed("AGENT_RESTARTED", true) };
        await this.deps.write(journal);
      }
      if (!journal) {
        journal = { claimKey: randomUUID(), scheduledDate: dueDate(config, now), phase: "claiming" };
        await this.deps.write(journal);
      }
      if (journal.phase === "claiming") {
        const response = await this.deps.request("commands/claim", { claimKey: journal.claimKey, scheduledDate: journal.scheduledDate }) as { command: Command | null };
        const command = response.command;
        if (!command || ["SUCCESS", "FAILED", "AUTH_REQUIRED"].includes(command.status)) { await this.deps.write(null); return; }
        if (command.command !== "RUN_REFRESH" || !uuid(command.id) || command.agent_id !== config.agent_id || command.claim_key !== journal.claimKey || command.status !== "RUNNING" || !["MANUAL", "SCHEDULED"].includes(command.source)) throw new Error("INVALID_COMMAND");
        journal = { ...journal, phase: "started", command };
        await this.deps.write(journal); // Durable BEFORE any browser/save side effect.
        await this.deps.log("run-started", { commandId: command.id, source: command.source, status: "RUNNING" });
        let done: Completion;
        try { done = completion(await this.deps.execute(command.command)); }
        catch { done = failed("EXECUTION_FAILED", true); }
        journal = { ...journal, phase: "completed", completion: done };
        await this.deps.write(journal);
      }
      if (journal.phase === "completed" && journal.command && journal.completion) {
        await this.deps.request(`commands/${journal.command.id}/complete`, completion(journal.completion));
        await this.deps.log("run-finished", { commandId: journal.command.id, source: journal.command.source, status: journal.completion.status, result: journal.completion.result, errorCode: journal.completion.error_code });
        await this.deps.write(null);
      }
    } finally { this.busy = false; }
  }
}
