import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { localChromePaths, resolveChromeExecutable } from "./local-chrome.ts";

export function profilePathIdentity(directory: string, platform: string = process.platform) {
  const normalized = platform === "win32" ? win32.normalize(directory).toLowerCase() : posix.normalize(directory);
  return createHash("sha256").update(`${platform}:${normalized}`).digest("hex").slice(0, 16);
}

export async function localProfileInfo(profileDirectory = localChromePaths().profileDirectory, platform: string = process.platform) {
  let profileExists = false;
  try {
    const info = await lstat(profileDirectory);
    profileExists = info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("PROFILE_INFO_UNAVAILABLE");
  }
  return {
    platform,
    // Redact the entire account-specific prefix, including custom/UNC locations.
    profilePath: platform === "win32" ? "%LOCALAPPDATA%\\NaukriAutomation\\ChromeProfile" : "~/Library/Application Support/NaukriAutomation/ChromeProfile",
    profileIdentity: profilePathIdentity(profileDirectory, platform),
    profileExists,
    chromeSource: "installed-google-chrome",
  };
}

export async function resolvedProfileInfo() {
  const paths = localChromePaths();
  await resolveChromeExecutable(paths.candidates);
  return localProfileInfo(paths.profileDirectory);
}
