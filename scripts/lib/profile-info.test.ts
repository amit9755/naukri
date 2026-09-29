import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localChromePaths, localChromeLaunchOptions } from "./local-chrome.ts";
import { localProfileInfo, profilePathIdentity } from "./profile-info.ts";

for (const command of ["validate-naukri-session.ts", "refresh-naukri-name.ts"]) {
  test(`login and ${command} use the same shared persistent-session configuration`, async () => {
    for (const script of ["naukri-login.ts", command]) {
      const source = await readFile(new URL(`../${script}`, import.meta.url), "utf8");
      assert.match(source, /["']\.\/lib\/local-session\.ts["']/);
      assert.match(source, /(?:await )?withLocalSession\(/);
      assert.doesNotMatch(source, /launchPersistentContext|\.launch\(|storageState|userDataDir|LOCALAPPDATA|ChromeProfile/);
    }
    const shared = await readFile(new URL("./local-session.ts", import.meta.url), "utf8");
    assert.match(shared, /chromium\.launchPersistentContext\(profileDirectory/);
    assert.match(shared, /localChromePaths\(\)/);
    assert.match(shared, /localChromeLaunchOptions\(\)/);
    assert.doesNotMatch(shared, /mkdtemp|storageState|\.kill\(/);
  });
}

test("Windows LOCALAPPDATA gives the dedicated path and stable normalized identity", () => {
  const config = localChromePaths("win32", "C:\\Users\\private-user", { LOCALAPPDATA: "C:\\Users\\private-user\\AppData\\Local" });
  assert.equal(config.profileDirectory, "C:\\Users\\private-user\\AppData\\Local\\NaukriAutomation\\ChromeProfile");
  assert.equal(profilePathIdentity(config.profileDirectory, "win32"), profilePathIdentity("c:/users/private-user/AppData/Local/NaukriAutomation/./ChromeProfile", "win32"));
  assert.notEqual(profilePathIdentity(config.profileDirectory, "win32"), profilePathIdentity("D:\\other\\ChromeProfile", "win32"));
  assert.equal(localChromeLaunchOptions("win32").chromiumSandbox, true);
});

test("profile info reads only directory metadata, redacts account paths and does not create profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-info-test-"));
  try {
    const existing = await localProfileInfo(directory, "win32");
    assert.equal(existing.profileExists, true);
    assert.equal(existing.profilePath, "%LOCALAPPDATA%\\NaukriAutomation\\ChromeProfile");
    assert.equal(existing.profileIdentity, profilePathIdentity(directory, "win32"));
    assert.equal(existing.chromeSource, "installed-google-chrome");
    assert.ok(!JSON.stringify(existing).includes(directory));
    const missing = await localProfileInfo(join(directory, "missing"), "win32");
    assert.equal(missing.profileExists, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
