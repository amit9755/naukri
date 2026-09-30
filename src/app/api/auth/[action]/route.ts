import { NextResponse } from "next/server.js";
import { ApiError, body, cookie } from "../../../../lib/server/control.ts";
import { authOrigin, authRequest, checkAuthOrigin, dashboardOwner, DashboardAuthError, logAuthFailure, validateSession } from "../../../../lib/server/dashboard-auth.ts";
import type { AuthStage } from "../../../../lib/server/dashboard-auth.ts";
import { exactKeys } from "../../../../../lib/automation/contracts.ts";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let stage: AuthStage = "origin";
  try {
    checkAuthOrigin(request);
    stage = "request";
    const { action } = await context.params;
    if (action === "logout") {
      const token = cookie(request, "naukri_access");
      if (token) {
        try { await authRequest("logout", undefined, token); }
        catch (error) { logAuthFailure("logout", error instanceof DashboardAuthError ? error : new DashboardAuthError("SESSION_ERROR", 503)); }
      }
      const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
      response.cookies.delete("naukri_access"); response.cookies.delete("naukri_refresh");
      return response;
    }
    let payload: Record<string, unknown>;
    if (action === "login") {
      payload = await body(request); exactKeys(payload, ["email", "password"]);
      if (typeof payload.email !== "string" || !payload.email.trim() || payload.email.length > 254 || typeof payload.password !== "string" || !payload.password || payload.password.length > 512) throw new ApiError(400, "INVALID_BODY");
      stage = "password";
    } else if (action === "session") {
      stage = "refresh";
      const token = cookie(request, "naukri_refresh");
      // Expected for a visitor with no session; no misleading failure log.
      if (!token) return NextResponse.json({ error: "Authentication unavailable or rejected" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      payload = { refresh_token: token };
    } else throw new ApiError(404, "NOT_FOUND");
    dashboardOwner();
    const session = validateSession(await authRequest(stage, payload));
    stage = "cookies";
    const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
    const options = { httpOnly: true, secure: new URL(authOrigin()).protocol === "https:", sameSite: "strict" as const, path: "/" };
    response.cookies.set("naukri_access", session.accessToken, { ...options, maxAge: session.expiresIn });
    response.cookies.set("naukri_refresh", session.refreshToken, { ...options, maxAge: 30 * 86400 });
    return response;
  } catch (error) {
    const failure = error instanceof DashboardAuthError ? error : new DashboardAuthError(stage === "request" ? "INVALID_REQUEST" : "SESSION_ERROR", error instanceof ApiError ? error.status : stage === "request" ? 400 : 500);
    logAuthFailure(stage, failure);
    return NextResponse.json({ error: "Authentication unavailable or rejected" }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
