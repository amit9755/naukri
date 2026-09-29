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

Challenge classification distinguishes alternative login links from active
verification. `Use OTP to Login`, `Forgot Password`, and `Sign in with Google`
do not by themselves trigger manual verification. Visible OTP/code inputs,
authenticator/MFA requests, visible CAPTCHA UI, explicit verification prompts,
and access restrictions still stop automated interaction. No challenge is solved.
The sanitized `challengeDetected` field reports `none`, `otp`, `captcha`, `mfa`,
`access-restriction`, or `unknown`. A normal form is submitted once; if it remains
unauthenticated, the command reports that and waits for manual inspection without
resubmitting. Credential values are never included in diagnostics.

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
Missing and ambiguous controls have distinct fixed reasons. Detection combines
associated labels, placeholders, accessible names, email/password input types,
and clearly email/username-related name/id attributes. Only visible candidates
are considered; one input matching multiple cues counts once. Exactly one candidate
per control is required before any typing. Login buttons must have the accessible
name `Login` or `Log in`. Diagnostics also include `usernameCandidateCount`,
`passwordCandidateCount`, and `submitCandidateCount` after each check.

Discovery uses the same Playwright Page passed to login navigation and brings that
tab to the foreground. It waits for DOMContentLoaded and visible semantic controls
within a shared five-second readiness budget; it does not retry navigation or
submission. The supplied Naukri labels/placeholders already match the semantic
selectors, including a username input of type `text`.

Discovery checks the main frame first, then visible child frames on the exact same
HTTPS origin. Third-party frames are counted but their contents are never searched.
Exactly one coherent form is required across eligible frames, with one candidate
per control. Multiple possible login frames stop without filling anything. The
selected frame's origin and verification state are checked before each interaction.

Sanitized structural fields are `frameCount`, `detectionFrame` (`main`, `child`,
`none`), `loginFormVisible`, `visibleInputCount`, `visibleButtonCount`, and
`readinessTimedOut`. Counts describe the selected frame, or the main frame when
none was selected. A readiness timeout can still be followed by discovery of an
already-rendered child form. These fields distinguish document-readiness and frame
scope problems without printing frame URLs, HTML, or control values.

With `NAUKRI_DIAGNOSTIC=true`, failed field detection leaves Chrome open and asks:
`Diagnostic stopped. Inspect the visible page, then type done to close.`
After this pause, an already authenticated current page is verified read-only
before closing. It never resumes credential filling, retries detection, or submits
Login again. No DOM HTML, field values, or input attributes are printed.
A detected challenge or access restriction stops automation for manual handling.

For this diagnostic run in Windows **CMD** (not PowerShell):

```cmd
cd /d C:\work\naukri
set "NAUKRI_DIAGNOSTIC=true"
npm run naukri:login
set "NAUKRI_DIAGNOSTIC="
```
 No credential values,
page text, URLs, raw browser errors, or session material are included.

Stages identify launch/setup, navigation, existing-session checking, login-page
and individual field/button detection, credential filling, submission,
post-submit observation, authentication checking, and manual verification.
Failed or uncertain authentication exits unsuccessfully. Verification uses
read-only dashboard navigation; no profile edits are submitted. If browser cleanup
fails, the final result reports failure even if authentication was detected earlier.

For local existing-session diagnostics, run in Windows PowerShell:

```powershell
cd C:\work\naukri
$env:NAUKRI_DIAGNOSTIC = "true"
npm run naukri:login
Remove-Item Env:NAUKRI_DIAGNOSTIC
```

This opt-in mode prints the existing-session progression:
`existing-session-navigation` → `existing-session-response-check` →
`existing-session-page-check` → `existing-session-auth-detection` (when needed).
An official login redirect skips authentication evaluation of the departing page
and reports `existingSessionAuthenticated: false`; the regular login flow then
continues. A normal logged-out page also reports false. Unknown pages, unsuccessful
responses, and unexpected browser errors stop without retries. A redirect that
interrupts evaluation is accepted only if the current destination is the official
HTTPS login page; other interrupted evaluations stop.

Failures include an allowlisted `errorCategory` only in diagnostic mode, such as
`navigation-timeout`, `page-closed`, `browser-closed`, `dns-failure`,
`connection-failure`, `navigation-interrupted`, `unexpected-status`, or `unknown`.
There are no raw errors, stacks, URLs, credentials, or session contents in this
output. Keep `DEBUG` and `PWDEBUG` unset even in this mode. A generic historical
failure does not by itself identify which underlying browser error occurred.

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

## Persistent profile identity and shutdown

`naukri:login`, `naukri:validate`, and `naukri:refresh-name` all call the same
`withLocalSession` helper. It resolves `localChromePaths()` once and launches
installed Chrome with `launchPersistentContext`, `headless: false`, and a 20-second
launch timeout. Windows sandboxing and the two existing excluded desktop flags
are shared. No command sets a Chrome channel, `--profile-directory`, or storageState.
Chrome manages the browser profile within the dedicated user-data directory.
Login and validation have zero action delay; refresh retains its 700 ms action delay.

The Windows directory is `%LOCALAPPDATA%\NaukriAutomation\ChromeProfile`;
macOS remains `~/Library/Application Support/NaukriAutomation/ChromeProfile`.
There was no code-level path or launch mismatch among these three commands.
`test:naukri-local-chrome` deliberately uses a disposable anonymous profile and
cannot preserve a login for these commands. The separate Next.js browser helper
also uses an unrelated headless browser.

`npm run naukri:profile-info` checks Chrome availability and directory metadata
without launching Chrome, creating a profile, or reading profile files. Its
`profilePath` masks the entire user-specific prefix. `profileIdentity` is a
16-character SHA-256 prefix of platform plus normalized path (case-normalized on
Windows), never of browser data. Matching identities establish matching configured
paths, not proof that authentication has persisted or remains valid on Naukri.

From Windows CMD, use the same terminal/account for each command:

```cmd
cd /d C:\work\naukri
set "NAUKRI_DIAGNOSTIC=true"
npm run naukri:profile-info
npm run naukri:login
npm run naukri:validate
```

After manually reaching the dashboard, leave Chrome open and type `done` in the
login terminal. The current page must pass the existing authentication checks,
then a read-only dashboard visit confirms accessibility. The script awaits one
graceful `context.close()` promise before its final success result. Do not close
Chrome yourself before confirmation. An unauthenticated `done` is reported as a
failure. No cookies are copied or exported, and the existing profile is never reset.

To compare refresh's identity afterward, its existing dry run does not save:

```cmd
npm run naukri:refresh-name
set "NAUKRI_DIAGNOSTIC="
```

Each diagnostic launch prints the same sanitized profile information before launch.
If identities differ, check the Windows account and LOCALAPPDATA environment used
by each terminal; no environment values or profile contents need to be shared.
If identities match but validation redirects to login, the session did not remain
usable; matching paths alone cannot establish the cause. No automatic login retry
or cookie manipulation is performed.

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
