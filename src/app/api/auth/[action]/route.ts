import { NextResponse } from "next/server";
import { ApiError, body, cookie, originCheck, required, supabase } from "../../../../lib/server/control.ts";
import { exactKeys } from "../../../../../lib/automation/contracts.ts";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    originCheck(request);
    const { action } = await context.params;
    if (action === "logout") {
      const token = cookie(request, "naukri_access");
      if (token) await supabase("/auth/v1/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      const response = NextResponse.json({ success: true });
      response.cookies.delete("naukri_access"); response.cookies.delete("naukri_refresh");
      return response;
    }
    let payload: Record<string, unknown>;
    if (action === "login") {
      payload = await body(request); exactKeys(payload, ["email", "password"]);
      if (typeof payload.email !== "string" || payload.email.length > 254 || typeof payload.password !== "string" || payload.password.length > 512) throw new ApiError(400, "INVALID_BODY");
    } else if (action === "session") {
      const token = cookie(request, "naukri_refresh");
      if (!token) throw new ApiError(401, "UNAUTHORIZED");
      payload = { refresh_token: token };
    } else throw new ApiError(404, "NOT_FOUND");
    const session = await supabase(`/auth/v1/token?grant_type=${action === "login" ? "password" : "refresh_token"}`, { method: "POST", body: JSON.stringify(payload) });
    if (session.user?.id !== required("DASHBOARD_USER_ID")) throw new ApiError(403, "FORBIDDEN");
    const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
    const options = { httpOnly: true, secure: new URL(required("APP_ORIGIN")).protocol === "https:", sameSite: "strict" as const, path: "/" };
    response.cookies.set("naukri_access", session.access_token, { ...options, maxAge: session.expires_in ?? 3600 });
    response.cookies.set("naukri_refresh", session.refresh_token, { ...options, maxAge: 30 * 86400 });
    return response;
  } catch (error) {
    return NextResponse.json({ error: "Authentication unavailable or rejected" }, { status: error instanceof ApiError ? error.status : 400, headers: { "Cache-Control": "no-store" } });
  }
}
