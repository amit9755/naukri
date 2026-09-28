# Naukri personal automation — Phase 1

Only the public-page browser test is implemented. Naukri automation is deferred.

## Browser setup

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
