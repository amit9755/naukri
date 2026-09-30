import { RegistrationFailure, registrationHttpFailure } from "./startup-diagnostics.ts";
import type { Identity } from "./storage.ts";
export class NetworkFailure extends Error {
  status: number;
  constructor(status = 0) { super("AGENT_NETWORK_FAILED"); this.status = status; }
}
export class AgentClient {
  identity: Identity;
  transport: typeof fetch;
  constructor(identity: Identity, transport: typeof fetch = fetch) { this.identity = identity; this.transport = transport; }
  private send(path: string, value: unknown, token: string) {
    return this.transport(`${this.identity.server}/api/agent/${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-ID": this.identity.id }, body: JSON.stringify(value),
      });
  }
  private async register(value: unknown, token: string) {
    let response: Response;
    try { response = await this.send("register", value, token); }
    catch { throw new RegistrationFailure("REGISTRATION_NETWORK_ERROR"); }
    // HTTP failures must not read, retain or print server response bodies.
    if (!response.ok) throw registrationHttpFailure(response.status);
    let result;
    try { result = await response.json(); }
    catch { throw new RegistrationFailure("REGISTRATION_INVALID_RESPONSE", response.status); }
    if (!result || typeof result !== "object" || Array.isArray(result) || result.registered !== true || result.agentId !== this.identity.id) {
      throw new RegistrationFailure("REGISTRATION_INVALID_RESPONSE", response.status);
    }
    return result;
  }
  async request(path: string, value: unknown, token = this.identity.secret) {
    if (path === "register") return this.register(value, token);
    try {
      const response = await this.send(path, value, token);
      if (!response.ok) throw new NetworkFailure(response.status);
      return await response.json();
    } catch (error) { throw error instanceof NetworkFailure ? error : new NetworkFailure(); }
  }
}
export function backoff(failures: number) { return Math.min(300_000, 20_000 * 2 ** Math.min(failures, 4)); }
