import type { Identity } from "./storage.ts";
export class NetworkFailure extends Error {
  status: number;
  constructor(status = 0) { super("AGENT_NETWORK_FAILED"); this.status = status; }
}
export class AgentClient {
  identity: Identity;
  transport: typeof fetch;
  constructor(identity: Identity, transport: typeof fetch = fetch) { this.identity = identity; this.transport = transport; }
  async request(path: string, value: unknown, token = this.identity.secret) {
    try {
      const response = await this.transport(`${this.identity.server}/api/agent/${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-ID": this.identity.id }, body: JSON.stringify(value),
      });
      if (!response.ok) throw new NetworkFailure(response.status);
      return await response.json();
    } catch (error) { throw error instanceof NetworkFailure ? error : new NetworkFailure(); }
  }
}
export function backoff(failures: number) { return Math.min(300_000, 20_000 * 2 ** Math.min(failures, 4)); }
