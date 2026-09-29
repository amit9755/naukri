import type { Page } from "playwright-core";

export type SessionErrorCategory = "navigation-timeout" | "browser-closed" | "page-closed" |
  "dns-failure" | "connection-failure" | "unexpected-status" | "navigation-interrupted" | "unknown";

// Inspect raw errors only in memory. Return an allowlisted category, never text.
export function sessionErrorCategory(error: unknown, page: Page): SessionErrorCategory {
  if (page.context().browser()?.isConnected() === false) return "browser-closed";
  if (page.isClosed()) return "page-closed";
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "TimeoutError") return "navigation-timeout";
  if (/\bERR_NAME_NOT_RESOLVED\b/.test(error.message)) return "dns-failure";
  if (/\bERR_(?:CONNECTION_[A-Z_]+|INTERNET_DISCONNECTED|NETWORK_CHANGED)\b/.test(error.message)) return "connection-failure";
  if (/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) return "navigation-interrupted";
  return "unknown";
}
