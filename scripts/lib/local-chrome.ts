import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export class LocalChromeError extends Error {}

export function localChromePaths(
  platform: string = process.platform,
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
) {
  if (env.VERCEL || (platform !== "darwin" && platform !== "win32")) {
    throw new LocalChromeError("Local Chrome commands support only local macOS and Windows computers.");
  }
  if (platform === "darwin") {
    return {
      candidates: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        posix.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      ],
      profileDirectory: posix.join(home, "Library", "Application Support", "NaukriAutomation", "ChromeProfile"),
    };
  }
  const local = env.LOCALAPPDATA;
  if (!local || !win32.isAbsolute(local) || !/^([a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(local)) {
    throw new LocalChromeError("Windows LOCALAPPDATA must identify an absolute per-user directory.");
  }
  return {
    candidates: [
      win32.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      win32.join("C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ],
    profileDirectory: win32.join(local, "NaukriAutomation", "ChromeProfile"),
  };
}

export async function resolveChromeExecutable(
  candidates = localChromePaths().candidates,
  platform: string = process.platform,
) {
  for (const candidate of candidates) {
    try {
      if (!(await lstat(candidate)).isFile()) continue;
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Check only the next known installed Chrome location. */ }
  }
  throw new LocalChromeError("Google Chrome was not found or is inaccessible in the supported installation locations. Install Google Chrome before running this command.");
}

// Resolve existing ancestors too, so redirects into the repository are rejected
// before creating a profile or launching Chrome.
export async function assertOutsideRepository(directory: string) {
  const repository = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  let ancestor = resolve(directory);
  const missing: string[] = [];
  let actual: string;
  for (;;) {
    try {
      actual = join(await realpath(ancestor), ...missing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      missing.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
  }
  for (const target of [resolve(directory), actual]) {
    const remainder = relative(repository, target);
    if (!remainder || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))) {
      throw new LocalChromeError("Browser profiles must remain outside the Git repository.");
    }
  }
}
