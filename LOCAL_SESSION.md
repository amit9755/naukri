# Local Chrome session

The active architecture uses normal headed Google Chrome on macOS. The existing
Vercel diagnostics are retained; no new serverless browser work is planned.

The login and validation commands share this dedicated profile:

`~/Library/Application Support/NaukriAutomation/ChromeProfile`

The profile is created on first use, outside the repository. Parent/profile
directories have owner-only permissions (0700); Chrome inherits umask 0077.
No normal Chrome profile or cookies are copied. Run only one session command
at a time; Chrome's own profile lock prevents concurrent use.

This directory contains sensitive authenticated state. Do not upload, share,
commit, or export it. Permissions do not encrypt it or protect it from other
processes running as your macOS user. Keep the Mac account and disk protected.
Enter credentials/OTP only in the Chrome window and decline password saving.
The scripts do not read input values or export cookies/storageState.

`npm run naukri:login` leaves Chrome open for manual login. Type `done` in the
terminal only after the signed-in dashboard is visible. Ctrl+C cancels and
closes Chrome. The dedicated profile persists after closing.

`npm run naukri:validate` makes one read-only dashboard navigation. It reports
block/login signals and requires visible sign-out evidence on a Naukri account
URL before claiming authentication. Hidden menus or changed page structure may
produce `UNKNOWN`; that does not prove the session expired. No account-specific
DOM selectors have been assumed or verified yet. There are no automatic login
attempts, profile edits, or scheduling.
