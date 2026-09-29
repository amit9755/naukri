# Naukri personal automation

Local Naukri session commands support macOS and Windows. The separate Next.js
public-page browser test is described below.

## Local Naukri session (macOS and Windows)

Use Node.js 24.x and install normal Google Chrome. These commands open a visible
installed Chrome window (`headless: false`) with a persistent dedicated profile.
They do not use the downloaded headless Chromium or require `browser:install`.
Linux and Vercel are unsupported for these local session commands.

On Windows, local session and diagnostic launches explicitly enable Chrome's
sandbox (`chromiumSandbox: true`), preventing Playwright's default `--no-sandbox`.
They also omit `--disable-dev-shm-usage` and `--enable-unsafe-swiftshader`, which
are unnecessary for this desktop setup. Other Playwright defaults and macOS
launch behavior remain unchanged. This removes the sandbox warning; successful
Naukri login still requires manual verification on Windows.


Chrome is checked in order at:

- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then
  `~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`, then
  `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, then
  `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`.

Missing or inaccessible Chrome stops the command with a sanitized error; there
is no fallback browser. Close the dedicated Chrome window before another command.

Persistent profile locations:

- macOS: `~/Library/Application Support/NaukriAutomation/ChromeProfile` (unchanged).
- Windows: `%LOCALAPPDATA%\NaukriAutomation\ChromeProfile`.

Profiles must stay outside this repository. Redirected paths into the repository
are rejected. macOS retains owner checks, mode 0700 and a private creation mask.
Windows requires an absolute `LOCALAPPDATA` and uses the per-user directory's
inherited Windows ACLs; POSIX chmod/UID checks do not apply there. Use your own
Windows account with its standard private LocalAppData permissions.
Do not copy or commit browser profiles, cookies, tokens, credentials, or storage
state. Each computer needs its own manual login; Git does not transfer sessions.

From PowerShell in your Windows checkout, run each command individually and
check its result before continuing:

```powershell
npm ci
npm run test:naukri-local-chrome
npm run naukri:login
npm run naukri:validate
```

The diagnostic visits the public homepage read-only using a temporary profile
that is removed afterward. Login first checks the existing session and skips
credential entry when authenticated. Otherwise it opens the official HTTPS
Naukri login page. Without environment credentials, complete login manually in
Chrome and type `done` after reaching the dashboard. Do not save your password.

Optional credential filling uses `NAUKRI_USERNAME` and `NAUKRI_PASSWORD` from
your local environment or the gitignored `.env` in the project directory. The
login command uses Node.js 24's `--env-file-if-exists`; existing environment
variables take precedence. Both values must be provided together. `.env.example`
contains empty entries only. Never commit the populated `.env`, paste credentials
into shell commands, or add them to logs, tickets, screenshots, or documentation.
Do not set these credentials on Vercel or other hosted environments.

In Windows PowerShell, create the local file only if it does not already exist:

```powershell
cd C:\work\naukri
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
git check-ignore .env
npm run naukri:login
```

Enter the two values privately in the editor and save. Use dotenv quoting if a
value contains spaces or `#`; keep the value exact. The command fills only uniquely
matched visible login controls and clicks Login once. Selectors are checked at
runtime; an unfamiliar layout stops without submission. It never retries a login.
Playwright debug logging (`DEBUG` or `PWDEBUG`) must be unset because debug output
can expose input values. No tracing, screenshots, or credential exports are enabled.

If a challenge is detected, automated interaction stops and Chrome stays open for
you to complete it manually. Type `done` only after the signed-in dashboard is
visible. If a submitted login cannot be confirmed (including an uncertain click
outcome), the command prints a sanitized diagnostic and waits for manual inspection
with no terminal timeout. It never clicks Login again. Enter anything other than
`done`, close Chrome, or press Ctrl+C to stop.

Before attempting login, the command prints only `credentialsConfigured` as a
boolean. Result diagnostics include `authenticated`, `profileAccessible`,
`manualVerificationRequired` (whether a challenge was detected),
`credentialsConfigured`, `usernameFieldFound`, `passwordFieldFound`,
`submitButtonFound`, `stage`, and `reason`. Field-found flags mean exactly one
visible candidate was found; false can also mean detection has not been reached.
Missing and ambiguous controls have distinct fixed reasons. No credential values,
page text, URLs, raw browser errors, or session material are included.

Stages identify launch/setup, navigation, existing-session checking, login-page
and individual field/button detection, credential filling, submission,
post-submit observation, authentication checking, and manual verification.
Failed or uncertain authentication exits unsuccessfully. Verification uses
read-only dashboard navigation; no profile edits are submitted. If browser cleanup
fails, the final result reports failure even if authentication was detected earlier.

Once login finishes and Chrome closes, reuse the same saved profile with:

```powershell
npm run naukri:validate
```

If validation is blocked, unknown, or unsuccessful, stop and inspect manually.
You may remove the credential entries from `.env` after successful login; the
persistent profile is reused independently of them. Keep that profile outside Git.

Optional read-only inspection of the name form:

```powershell
npm run naukri:refresh-name
```

Only when you intentionally want to submit the existing name once, run manually:

```powershell
npm run naukri:refresh-name -- --save
```

The save command restores the exact original name before submitting and verifies
it afterward. On uncertainty it stops without retrying the save or submitting an
automatic correction. No selectors or profile-editing behavior were changed for
platform support. There is no stealth, challenge bypass, or proxy rotation.

## Separate Next.js browser setup

Use Node.js 24.x locally and on Vercel. Dependencies are pinned:
`playwright-core@1.63.0` targets Chromium 153 and
`@sparticuz/chromium-min@153.0.0` provides serverless launch support.

Locally, Playwright launches its native headless Chromium. On Vercel, the helper
downloads the pinned Linux release pack for the runtime architecture and extracts
it into temporary storage. Cold starts depend on GitHub release availability.
The desktop browser is not deployed. Both packages are externalized in Next.js.

Reference: https://github.com/Sparticuz/chromium

## Local test

Run these individually, checking each result:

1. `npm ci`
2. `npm run browser:install`
3. `npm run dev`
4. In another terminal: `curl --fail-with-body http://localhost:3000/api/test-browser`

Expected JSON:

```json
{
  "success": true,
  "browser": "launched",
  "pageTitle": "Example Domain",
  "timestamp": "<current ISO timestamp>"
}
```

The endpoint uses Node.js with a 120-second function limit, a 20-second launch
 timeout, and a 25-second navigation timeout. It makes one browser attempt,
checks the HTTP response and title, and closes the browser in `finally`.
Errors return HTTP 500 with a stage; raw browser errors and secrets are omitted.
Responses are not cached. The target is fixed to https://example.com.

## Vercel test — after local confirmation

Deploy as a Next.js project with Node.js 24.x. Set `ENABLE_BROWSER_TEST=true`
for the deployment environment before deployment. Open `/api/test-browser`
on the deployed URL and verify the JSON above. Local success alone does not
validate the Linux binary or Vercel networking.

The test endpoint is public while enabled. Retain Vercel deployment protection
where available. Set `ENABLE_BROWSER_TEST=false` and redeploy after testing
to disable the endpoint (HTTP 404). No secrets are needed for this phase.

Stop until both local and deployed tests are confirmed before Phase 2.

## Validation

`npm run lint` and `npm run build` passed. The starter UI downloads Google Fonts
at build time. The local endpoint returned `success: true` and
`pageTitle: "Example Domain"`. These checks ran on the workstation's Node.js 26;
the configured Vercel Node.js 24 runtime still needs deployment validation.

Vercel validation is pending.
