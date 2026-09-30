# Naukri Automation

A private Next.js dashboard on Vercel controls an outbound Windows agent. Supabase
stores agent identity hashes, configuration, commands and sanitized run history.
Only Windows opens Chrome and runs the existing same-name save workflow.

```text
Browser → Vercel dashboard / authenticated APIs → Supabase
                         ↑ HTTPS polling
                   Windows agent
                         ↓ fixed RUN_REFRESH action
           existing persistent Chrome → Naukri
```

There is no inbound Windows listener, remote shell, Windows Task Scheduler,
server-side Naukri browser, cookie transfer or automatic Naukri login. The old
`/api/test-browser` and `/api/test-naukri` endpoints are retired (HTTP 410).
`browser:install` is retained for compatibility but is not needed by this design.

## Setup: Supabase

1. Create/use a Supabase project. In Authentication, enable email/password login,
   disable public signup, and manually create/confirm your own dashboard user.
   This is a separate dashboard identity, not your Naukri credentials. Keep its
   password in your password manager; do not put it in environment variables.
2. Copy that user's UUID for `DASHBOARD_USER_ID`. Only this one user is authorized.
   The server also verifies ownership of each agent before mutations.
3. Run `supabase/migrations/202609290001_agent_control.sql` once in the Supabase
   SQL editor (or apply it with your normal Supabase migration tooling). It creates
   four tables, indexes, constraints and transactional RPC functions. It assumes
   Supabase's existing `auth.users`, `anon`, `authenticated`, and `service_role`.
4. Leave RLS enabled. Browser roles have no direct table/RPC privileges. Only the
   Vercel server uses the service-role key. Do not add public RLS policies.
5. In Auth URL settings, set the Site URL to your eventual HTTPS dashboard origin.
   The password flow uses no external callback. Disable unused Auth providers and
   retain Supabase Auth rate limits. Configure trusted recovery email/SMTP if needed.

## Setup: Vercel

Import this repository as a Next.js project, choose **Node.js 24.x**, and use
`npm ci` / `npm run build`. Set these **server-only** environment variables in
Vercel, then deploy manually:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project's HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Same project's publishable key for user Auth (legacy anon key also accepted) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; Vercel only |
| `DASHBOARD_USER_ID` | UUID of the single allowed Supabase Auth user |
| `APP_ORIGIN` | Exact HTTPS deployment/custom origin, without a trailing slash |
| `AGENT_ENROLLMENT_SECRET` | Random URL-safe shared enrollment secret, at least 32 characters |

Generate the enrollment secret privately using a password manager (for example,
64 random hexadecimal characters). Temporarily place the same value in the local
Windows `.env` for registration. Never use a Naukri password as any of these keys.
There are no `NEXT_PUBLIC_` variables or browser-exposed service credentials.
Do not set `NAUKRI_USERNAME` or `NAUKRI_PASSWORD` on Vercel.

Open `https://your-deployment/dashboard`; unauthenticated visitors go to `/login`.
Sign in using the Supabase dashboard user. Access and refresh tokens stay in
HttpOnly, Secure, SameSite=Strict cookies. Mutation APIs additionally check Origin.
Use a stable production origin; previews with a different origin fail this check.
If Vercel Deployment Protection is enabled, ensure your production agent can reach
its authenticated API routes; a Vercel protection page cannot be used as an API.
Do not enable request-body/header logging in external observability tools.

## Dashboard sign-in diagnostics

User Auth (password sign-in, session refresh, logout and verified user lookup) uses
`SUPABASE_PUBLISHABLE_KEY` in the `apikey` header. Only an actual user access JWT
is sent as an Authorization bearer for user lookup/logout. The service-role helper
is reserved for privileged database access. Auth never falls back to that key.

In Supabase, open **Project Settings → API Keys → Publishable and secret API keys**
and copy the publishable key (`sb_publishable_...`) from the same project as
`SUPABASE_URL`. Set `SUPABASE_PUBLISHABLE_KEY` in Vercel's **Production** environment
and redeploy the updated code manually. A legacy **anon** key from the legacy API
keys tab is also accepted; never use the legacy service-role or a secret key here.
Keep `SUPABASE_SERVICE_ROLE_KEY` unchanged and server-only for database operations.
The public-safe Auth key is consumed on the server, so no `NEXT_PUBLIC_` variable
or direct browser Supabase client is needed. Cookies remain HttpOnly.

For this deployment, set `APP_ORIGIN=https://naukri-gamma.vercel.app`, without a
path. Keep `DASHBOARD_USER_ID` equal to the intended Supabase Auth user's UUID.
All user checks enforce this allowlist on the server. There is no middleware:
`/dashboard` verifies the access cookie server-side and redirects to `/login` if
unverified; API routes independently verify access. The login page and dashboard
can refresh the session through the protected same-origin session endpoint.

The browser intentionally retains a generic sign-in error. In Vercel runtime logs,
filter for `dashboard-auth-failure`. Only a fixed `stage` and `code` are recorded:

| Code | Interpretation |
| --- | --- |
| `INVALID_CREDENTIALS` | Supabase explicitly returned `invalid_credentials`; not inferred from every rejection |
| `AUTH_CONFIGURATION_ERROR` | Missing/malformed URL, Auth key or owner UUID, or provider key rejection |
| `UNAUTHORIZED_DASHBOARD_USER` | Auth succeeded but user UUID does not match the server allowlist |
| `SESSION_ERROR` | Invalid/expired session or malformed token response |
| `ORIGIN_MISMATCH` | Request Origin does not match `APP_ORIGIN` |
| `AUTH_UNAVAILABLE` | Provider/network failure |
| `AUTH_RATE_LIMITED` | Provider returned HTTP 429 |
| `AUTH_REQUEST_REJECTED` | Other provider sign-in rejection; inspect project Auth settings privately |
| `INVALID_REQUEST` | Invalid request body/action |

Stages distinguish `origin`, `request`, `password`, `refresh`, `user`, `logout` and
`cookies`. No password, email, token, cookie, API key, raw provider error or exception
stack is logged. A visitor with no refresh cookie is a normal unauthenticated state.

The previous UI produced the same message for every failed POST or fetch failure.
Its API discarded provider errors, and Auth used the database service-role helper.
That code alone cannot identify which production branch failed: valid legacy
service-role credentials do not inherently prove a password sign-in failure.
After deploying this correction, attempt your dashboard login once and inspect the
fixed category if it still fails. Do not share environment values or request bodies.
Reference: [Supabase API key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

## Setup: Windows (CMD)

Use the same Windows user and `LOCALAPPDATA` as your working Naukri session.
Installed Chrome and Node.js 24.x are required. Do not move or reset ChromeProfile.
Once you have transferred these changes through your normal Git workflow:

```cmd
cd /d C:\work\naukri
git pull
npm ci
if not exist .env copy .env.example .env
notepad .env
git check-ignore .env
npm run naukri:profile-info
```

Edit `.env` privately. On **Windows only**, set:

| Variable | Purpose |
| --- | --- |
| `AGENT_SERVER_URL` | Same HTTPS origin as `APP_ORIGIN`, no path/query |
| `AGENT_ENROLLMENT_SECRET` | Temporary shared enrollment secret |
| `AGENT_NAME` | Optional non-personal display name, e.g. Windows laptop |
| `NAUKRI_USERNAME`, `NAUKRI_PASSWORD` | Optional local first-login only; existing entries may stay local |

Do not copy the Supabase service key onto Windows. Leave server-only example
entries empty or remove them from this local file. Leave `DEBUG` and `PWDEBUG`
unset. The refresh child does not receive Naukri credentials, Supabase keys or
agent secrets; it relies on Chrome's existing authenticated profile.

Close any dedicated-profile Chrome window before starting the agent. Start:

```cmd
npm run naukri:agent
```

First startup creates `%LOCALAPPDATA%\NaukriAutomation\agent.json` with random
agent/machine UUIDs and a 256-bit random secret. The server stores only its hash.
Registration binds the agent to the allowed dashboard owner; a lost response can
be replayed safely. The local identity is pinned to its server origin. Do not
share, move, print or commit this file. Windows uses your LocalAppData ACLs.

Check the dashboard: the agent should become ONLINE with automation **disabled**.
Remove `AGENT_ENROLLMENT_SECRET` from Windows `.env` after successful registration;
rotate/remove it on Vercel to close enrollment, then redeploy. Existing agents use
their own secrets and do not need enrollment. Start-up with an existing registered
identity never creates another identity. Registration failures are sanitized.

In another CMD terminal, inspect status and install optional per-user auto-start:

```cmd
cd /d C:\work\naukri
npm run naukri:agent:status
npm run naukri:agent:install
```

Installation creates `Naukri Agent.lnk` in your user's Startup folder. It starts
a hidden PowerShell supervisor **after your next Windows sign-in**, with a 30-second
agent restart delay and local logs. No administrator, service, scheduled task, or
permanent CMD window is required. Chrome itself remains visible. Keep this checkout
in the same location, with Node available on the user's PATH. Enterprise execution
policy may require your administrator to approve the scripts; no policy bypass is
installed. Nothing runs while the laptop is off, asleep, or signed out.

## Daily operation and scheduling

The dashboard polls every 12 seconds. ONLINE means a heartbeat within two minutes;
a stale heartbeat becomes OFFLINE. The agent heartbeats approximately every
60 seconds and polls for commands every 20 seconds. Network errors use backoff up
to five minutes; stale configuration prevents new claims until heartbeat recovers.

Set the schedule and enable it deliberately. Default: **06:30 Asia/Kolkata**,
once per local calendar date. Catch-up defaults on: starting late permits one
scheduled attempt that day, not a backlog of prior days. With catch-up off, only
the scheduled minute is eligible; a late poll can miss it. Schedule edits apply
within a heartbeat, and the database rechecks enabled/timezone/time when claiming.
DST uses Temporal's compatible rule: earlier occurrence on an overlap, forward
through a gap. Server-side scheduling uses the same rule. Timezone database
versions on Node and PostgreSQL should be kept current.

`last_scheduled_date`, a unique daily command constraint and a local durable journal
prevent duplicate scheduled execution after restart. A failed/auth-required attempt
still consumes that day's scheduled attempt. Changing the time does not permit a
second scheduled run that day. Disabling automation prevents new scheduled jobs;
it does not cancel an already queued/running command. Manual Run now remains
available even when the schedule is disabled.

**Run now queues a real single profile save**, including while Windows is offline;
the queued command runs when the agent reconnects. It creates one PENDING command,
atomically claimed as RUNNING, then SUCCESS, FAILED or AUTH_REQUIRED. Another
PENDING/RUNNING command returns 409 and is shown in the dashboard. No profile save
is retried automatically. Avoid queuing a manual run near the scheduled time if
you do not want both a manual and a daily run; these are distinct intentional jobs.

Next run is the scheduled time or the currently due catch-up, shown in the configured
timezone. When offline this is eligibility, not a promise that the laptop will wake.
History shows the latest 30 runs. `refreshTimestampVerified:false` is displayed
separately and does not invalidate a confirmed original-name save/reload verification.

## Stop, session restoration and updates

Stop gracefully from another terminal:

```cmd
cd /d C:\work\naukri
npm run naukri:agent:stop
npm run naukri:agent:status
```

The agent finishes any active refresh before exiting; it never kills Chrome.
Wait for `running:false` and Chrome to close before another profile command.
The stop marker also stops the supervisor. A foreground `npm run naukri:agent`
clears that marker; install alone does not clear it. To resume automatic startup,
remove **only** the stop marker and open the Startup shortcut (or sign out/in):

```cmd
del "%LOCALAPPDATA%\NaukriAutomation\agent.stop"
start "" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Naukri Agent.lnk"
```

If the dashboard says **Naukri login required on Windows**, disable scheduling,
stop the agent and wait for it to finish. Then restore the session locally:

```cmd
npm run naukri:login
npm run naukri:validate
```

Complete verification manually. Leave Chrome open until you type `done` in the
terminal; authentication is checked before graceful context closure. Do not export
cookies. After validation succeeds, restart the agent and re-enable the schedule.
The session badge reflects the last agent refresh, so it remains AUTH_REQUIRED
until a later successful run reports back. The agent never calls the login script.
For updates, stop and wait, pull changes, run `npm ci`, then restart.

To uninstall auto-start, stop the agent and delete only its shortcut:

```cmd
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Naukri Agent.lnk"
```

This leaves the identity, logs and existing Chrome profile intact.

## Logs, recovery and secret rotation

```cmd
npm run naukri:agent:status
type "%LOCALAPPDATA%\NaukriAutomation\logs\agent.log"
type "%LOCALAPPDATA%\NaukriAutomation\logs\supervisor.log"
```

Logs contain fixed lifecycle/error codes, timestamps, command UUIDs, source,
status and allowlisted boolean results. Each log rotates at approximately 1 MB
with one backup. Child stdout/stderr are kept only in bounded memory and never
written to logs or sent to the server. Do not inspect/share `agent.json`, profile
files, cookies, DOM dumps, debug traces, or populated environment files.

| Symptom | Check/action |
| --- | --- |
| Agent OFFLINE | Windows awake/signed in, Node24, supervisor/status, outbound HTTPS, Vercel protection and environment |
| Registration fails | Same enrollment secret on both sides, correct owner UUID/migration, HTTPS origin; no identity deletion |
| Heartbeat/poll failures | Network and Supabase availability; fixed-code logs only; network retries do not repeat saves |
| AUTH_REQUIRED | Stop and restore Naukri session manually as above |
| REFRESH_FAILED / INVALID_RESULT | Inspect Windows and run read-only validation; no automatic save retry |
| CHROME_FAILED | Check Node/Chrome availability and local process launch; do not remove browser locks manually |
| AGENT_RESTARTED | Crash happened after execution was marked started; save outcome may be unknown; inspect before another run |
| STALE_RUNNING | After 30 minutes a status/claim request terminalizes uncertainty and disables scheduling; inspect Windows before re-enabling |
| Active command conflict | Wait for the existing operation; do not create retries |

The journal records claim key before requesting work, started before executing,
and completed before reporting. Lost claim responses replay the same command;
lost completion responses resend only sanitized results. A crash after started
reports uncertainty without rerunning it, even if the save may not have occurred.
This favors at-most-once attempts over automatic recovery of uncertain saves.
No distributed design can guarantee a confirmed external save across a crash.
Stale reconciliation never requeues work and is invoked on authenticated status
or claim requests, not by a separate cron service. Do not delete the journal to
force recovery. If a child Chrome remains open after a crash, inspect and close
it normally before queuing anything else.

For routine **agent secret rotation**, stop and wait, then:

```cmd
npm run naukri:agent:rotate
npm run naukri:agent
```

Rotation stages a new random secret locally, updates the server with the old
credential, and persists the new one. An interrupted rotation verifies the staged
secret before retrying the update. No secret is printed. If the secret is suspected
compromised, revoke its server hash from the Supabase admin console immediately
and inspect pending work; do not rely on routine rotation while an attacker has
access. Re-enrollment/recovery requires deliberate admin assistance, never copying
another agent's identity. Rotate the Vercel service-role key through Supabase and
update/redeploy Vercel; it does not belong in agent files.

## Security and checks

- Authentication/owner authorization on dashboard APIs; strong random agent
  bearer secrets in headers, hashed storage and timing-safe comparisons.
- Strict command allowlist and fixed local Node executable/script arguments;
  no shell or remote-supplied flags, file paths, URLs or code execution.
- Bounded JSON input, fixed error responses, safe result projection, HttpOnly
  cookies, Origin checks, no-store responses, RLS and service-only RPC grants.
- Database active/daily uniqueness, row-lock claiming, claim replay, one local
  agent lock and a single-flight worker; Chrome's persistent profile lock remains.
- No automatic login, OTP/CAPTCHA/MFA interaction, stealth, spoofing or proxies.
- `.env*` (except the blank example), identities, journals, logs and browser
  authentication material are gitignored. Never add them with `git add -f`.

Run local checks without launching Chrome:

```cmd
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Tests use fake Naukri/Playwright operations and an isolated in-memory PostgreSQL
engine for the migration/transaction rules. They do not contact Naukri/Supabase,
install Startup entries or perform profile saves. A real Supabase/Vercel deployment,
Windows Startup launch and end-to-end run require your manual configuration and
validation; they were not executed during development. PGlite validates SQL but
does not replace load/concurrency testing against deployed PostgreSQL.

## Existing local commands and Chrome behavior

The following reference remains applicable independently of the agent. Stop the
agent before opening the dedicated profile with another command. Existing login,
validate, profile-info, dry-run and explicit `--save` commands are retained. The
refresh selectors and name/save/reload workflow are unchanged; only a fixed safe
error code was added to its failure result for the agent adapter.

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
cannot preserve a login for these commands. The retired Next.js browser routes return HTTP 410 and never launch a browser.

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
