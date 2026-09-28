import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOutsideRepository, localChromePaths, resolveChromeExecutable } from "./local-chrome.ts";

test("platform paths preserve Mac defaults and Windows candidate order", () => {
  const mac = localChromePaths("darwin", "/Users/test", {});
  assert.equal(mac.profileDirectory, "/Users/test/Library/Application Support/NaukriAutomation/ChromeProfile");
  assert.equal(mac.candidates[1], "/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  const windows = localChromePaths("win32", "C:\\Users\\test", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
  assert.deepEqual(windows.candidates, [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  assert.equal(windows.profileDirectory, "C:\\Users\\test\\AppData\\Local\\NaukriAutomation\\ChromeProfile");
  assert.throws(() => localChromePaths("linux", "/home/test", {}));
  assert.throws(() => localChromePaths("darwin", "/Users/test", { VERCEL: "1" }));
  assert.throws(() => localChromePaths("win32", "C:\\Users\\test", {}));
  assert.throws(() => localChromePaths("win32", "C:\\Users\\test", { LOCALAPPDATA: "relative" }));
});

test("resolver checks files, access, fallback order, and sanitized failure without launching", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrome-resolver-test-"));
  try {
    const executable = join(root, "chrome.exe");
    const directory = join(root, "directory");
    await mkdir(directory);
    await writeFile(executable, "test fixture");
    await chmod(executable, 0o700);
    assert.equal(await resolveChromeExecutable([join(root, "missing"), directory, executable], "win32"), executable);
    assert.equal(await resolveChromeExecutable([executable], "darwin"), executable);
    await assert.rejects(resolveChromeExecutable([directory], "win32"), /Google Chrome was not found/);
    await assertOutsideRepository(root);
    await assert.rejects(assertOutsideRepository(fileURLToPath(new URL("../../ChromeProfile", import.meta.url))), /outside the Git repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
