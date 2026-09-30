export const startupCategories = [
  "LOCAL_SETUP_ERROR", "INVALID_SERVER_ORIGIN", "IDENTITY_ERROR", "ENROLLMENT_REQUIRED",
  "REGISTRATION_UNAUTHORIZED", "REGISTRATION_FORBIDDEN", "REGISTRATION_NOT_FOUND",
  "REGISTRATION_CONFLICT", "REGISTRATION_RATE_LIMITED", "REGISTRATION_SERVER_ERROR",
  "REGISTRATION_NETWORK_ERROR", "REGISTRATION_INVALID_RESPONSE", "REGISTRATION_UNKNOWN_ERROR",
  "AGENT_STOPPED_CHECK_LOCAL_SETUP",
] as const;
export type StartupCategory = typeof startupCategories[number];
export type StartupStage = "local" | "origin" | "identity" | "enrollment" | "registration" | "running";
export class RegistrationFailure extends Error {
  category: StartupCategory;
  httpStatus?: number;
  constructor(category: StartupCategory, httpStatus?: number) {
    super(category);
    this.category = category;
    this.httpStatus = httpStatus;
  }
}
export function registrationHttpFailure(status: number) {
  const category = status === 401 ? "REGISTRATION_UNAUTHORIZED" :
    status === 403 ? "REGISTRATION_FORBIDDEN" : status === 404 ? "REGISTRATION_NOT_FOUND" :
    status === 409 ? "REGISTRATION_CONFLICT" : status === 429 ? "REGISTRATION_RATE_LIMITED" :
    status >= 500 && status <= 599 ? "REGISTRATION_SERVER_ERROR" : "REGISTRATION_UNKNOWN_ERROR";
  return new RegistrationFailure(category, status);
}
export function startupDiagnostic(error: unknown, stage: StartupStage) {
  // Project only trusted fixed categories. Never serialize an Error or inspect its
  // arbitrary message/cause/body/headers, including URL and JSON parsing errors.
  if (stage === "registration" && error instanceof RegistrationFailure) {
    const category = startupCategories.find((value) => value.startsWith("REGISTRATION_") && value === error.category) ?? "REGISTRATION_UNKNOWN_ERROR";
    const status = error.httpStatus;
    return { success: false, error: category,
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) };
  }
  const categories: Record<StartupStage, StartupCategory> = {
    local: "LOCAL_SETUP_ERROR", origin: "INVALID_SERVER_ORIGIN", identity: "IDENTITY_ERROR",
    enrollment: "ENROLLMENT_REQUIRED", registration: "REGISTRATION_UNKNOWN_ERROR", running: "AGENT_STOPPED_CHECK_LOCAL_SETUP",
  };
  return { success: false, error: categories[stage] ?? "LOCAL_SETUP_ERROR" };
}
