export const statuses = ["PENDING", "RUNNING", "SUCCESS", "FAILED", "AUTH_REQUIRED"] as const;
export type RunStatus = typeof statuses[number];
export type TerminalStatus = "SUCCESS" | "FAILED" | "AUTH_REQUIRED";
export type SafeResult = {
  success: boolean; mode?: "same-name-save" | "dry-run"; saveAttempted: boolean;
  originalNamePreserved: boolean | null; verifiedAfterReload: boolean; refreshTimestampVerified: boolean;
};
export const errorCodes = ["AUTH_REQUIRED", "REFRESH_FAILED", "CHROME_FAILED", "AGENT_RESTARTED", "STALE_RUNNING", "INVALID_RESULT", "EXECUTION_FAILED"] as const;
export type ErrorCode = typeof errorCodes[number];
export type Completion = { status: TerminalStatus; result: SafeResult; error_code: ErrorCode | null };
export type Config = { agent_id: string; enabled: boolean; schedule_time: string; timezone: string; catch_up: boolean; last_scheduled_date: string | null; account_label?: string };
export type Command = { id: string; agent_id: string; command: "RUN_REFRESH"; status: RunStatus; source: "MANUAL" | "SCHEDULED"; claim_key: string | null };
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_BODY");
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("INVALID_BODY");
}
export function safeResult(raw: unknown): SafeResult {
  const value = record(raw);
  return {
    success: value.success === true,
    ...(value.mode === "same-name-save" || value.mode === "dry-run" ? { mode: value.mode } : {}),
    saveAttempted: value.saveAttempted === true,
    originalNamePreserved: typeof value.originalNamePreserved === "boolean" ? value.originalNamePreserved : null,
    verifiedAfterReload: value.verifiedAfterReload === true,
    refreshTimestampVerified: value.refreshTimestampVerified === true,
  };
}
export function completion(raw: unknown): Completion {
  const value = record(raw);
  exactKeys(value, ["status", "result", "error_code"]);
  if (!["SUCCESS", "FAILED", "AUTH_REQUIRED"].includes(String(value.status))) throw new Error("INVALID_BODY");
  const result = safeResult(value.result);
  if (value.status === "SUCCESS" && !(result.success && result.mode === "same-name-save" && result.saveAttempted && result.originalNamePreserved && result.verifiedAfterReload)) throw new Error("INVALID_BODY");
  if (value.status === "SUCCESS" && value.error_code !== null) throw new Error("INVALID_BODY");
  if (value.status === "AUTH_REQUIRED" && value.error_code !== "AUTH_REQUIRED") throw new Error("INVALID_BODY");
  if (value.status !== "SUCCESS" && result.success) throw new Error("INVALID_BODY");
  if (value.error_code !== null && !errorCodes.includes(value.error_code as ErrorCode)) throw new Error("INVALID_BODY");
  return { status: value.status as TerminalStatus, result, error_code: value.error_code as ErrorCode | null };
}
export function failed(error_code: ErrorCode, saveAttempted = false): Completion {
  return { status: error_code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "FAILED", error_code,
    result: { success: false, saveAttempted, originalNamePreserved: null, verifiedAfterReload: false, refreshTimestampVerified: false } };
}
export function online(lastSeen: string | null, now = Date.now()) {
  return !!lastSeen && now - Date.parse(lastSeen) <= 120_000 && now >= Date.parse(lastSeen) - 10_000;
}
