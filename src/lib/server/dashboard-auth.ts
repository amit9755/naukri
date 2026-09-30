import { uuid } from "../../../lib/automation/contracts.ts";

export type AuthCode = "INVALID_CREDENTIALS" | "AUTH_CONFIGURATION_ERROR" | "UNAUTHORIZED_DASHBOARD_USER" | "SESSION_ERROR" | "ORIGIN_MISMATCH" | "INVALID_REQUEST" | "AUTH_UNAVAILABLE" | "AUTH_RATE_LIMITED" | "AUTH_REQUEST_REJECTED";
export type AuthStage = "origin" | "request" | "password" | "refresh" | "user" | "logout" | "cookies";
export class DashboardAuthError extends Error {
  code: AuthCode;
  status: number;
  constructor(code: AuthCode, status: number) { super(code); this.code = code; this.status = status; }
}
export function logAuthFailure(stage: AuthStage, error: DashboardAuthError) {
  // Never serialize the exception, request, provider payload or environment.
  console.error(JSON.stringify({ event: "dashboard-auth-failure", stage, code: error.code }));
}
function origin(value: string | undefined, local = false) {
  try {
    const url = new URL(value?.trim() ?? "");
    if ((url.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch { throw new DashboardAuthError("AUTH_CONFIGURATION_ERROR", 503); }
}
export function authOrigin() { return origin(process.env.APP_ORIGIN, true); }
export function checkAuthOrigin(request: Request) {
  if (request.headers.get("origin") !== authOrigin()) throw new DashboardAuthError("ORIGIN_MISMATCH", 403);
}
function configuration() {
  const url = origin(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  // Legacy anon JWT is supported; never accept a service-role key for user Auth.
  if (!publicKey) {
    try { publicKey = key.split(".").length === 3 && JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon"; } catch { /* reject malformed key */ }
  }
  if (!publicKey) throw new DashboardAuthError("AUTH_CONFIGURATION_ERROR", 503);
  return { url, key };
}
export function dashboardOwner() {
  const id = process.env.DASHBOARD_USER_ID?.trim();
  if (!uuid(id)) throw new DashboardAuthError("AUTH_CONFIGURATION_ERROR", 503);
  return id;
}
export function authorizeDashboardUser(user: unknown) {
  const owner = dashboardOwner();
  if (!user || typeof user !== "object" || !("id" in user) || !uuid(user.id)) throw new DashboardAuthError("SESSION_ERROR", 401);
  if (user.id !== owner) throw new DashboardAuthError("UNAUTHORIZED_DASHBOARD_USER", 403);
  return owner;
}
export async function authRequest(stage: "password" | "refresh" | "user" | "logout", payload?: Record<string, unknown>, accessToken?: string) {
  const { url, key } = configuration();
  const path = stage === "password" ? "token?grant_type=password" : stage === "refresh" ? "token?grant_type=refresh_token" : stage;
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/${path}`, {
      method: stage === "user" ? "GET" : "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { apikey: key, "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch { throw new DashboardAuthError("AUTH_UNAVAILABLE", 503); }
  if (response.ok && stage === "logout") return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code = data?.code ?? data?.error_code;
    if (["invalid_api_key", "bad_jwt", "no_authorization"].includes(code) && stage === "password") throw new DashboardAuthError("AUTH_CONFIGURATION_ERROR", 503);
    if (code === "invalid_api_key") throw new DashboardAuthError("AUTH_CONFIGURATION_ERROR", 503);
    if (stage === "password" && code === "invalid_credentials") throw new DashboardAuthError("INVALID_CREDENTIALS", 401);
    if (response.status === 429) throw new DashboardAuthError("AUTH_RATE_LIMITED", 429);
    if (response.status >= 500) throw new DashboardAuthError("AUTH_UNAVAILABLE", 503);
    if (stage === "password") throw new DashboardAuthError(response.status === 401 ? "AUTH_CONFIGURATION_ERROR" : "AUTH_REQUEST_REJECTED", response.status === 401 ? 503 : 401);
    throw new DashboardAuthError("SESSION_ERROR", 401);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new DashboardAuthError("SESSION_ERROR", 502);
  return data;
}
export function validateSession(session: unknown) {
  if (!session || typeof session !== "object") throw new DashboardAuthError("SESSION_ERROR", 502);
  const value = session as Record<string, unknown>;
  authorizeDashboardUser(value.user);
  // Validate before setting either cookie; partial/malformed sessions fail closed.
  if (typeof value.access_token !== "string" || !/^[A-Za-z0-9._~-]+$/.test(value.access_token) || value.access_token.length > 3800 ||
      typeof value.refresh_token !== "string" || !/^[A-Za-z0-9._~-]+$/.test(value.refresh_token) || value.refresh_token.length > 3800 ||
      typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0) throw new DashboardAuthError("SESSION_ERROR", 502);
  return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresIn: value.expires_in };
}
