# Console QA — end-to-end engagement

> **Status: landed, not yet gating, pass rate UNKNOWN.** This suite was authored on 2026-07-05 and
> merged on 2026-08-23 without ever having been executed against the console it now ships beside —
> 1,640 commits of drift, including the base-ui migration and the canvas overhaul. Every document in
> this directory (the findings log, the performance numbers, the coverage matrix) describes the July
> console, not today's.
>
> It is deliberately **not** wired into any required check. It runs as its own Playwright project:
>
> ```
> ALETHIA_QA_E2E=1 pnpm -F console exec playwright test --project=qa
> ```
>
> The triage — which specs still describe the current UI, and what the gate posture should be — is
> tracked in **#2417**. Treat a green run here as unproven until that lands.


This directory holds the deliverables of the exhaustive e2e QA pass over `apps/console`:

- **`flow-catalog.md`** — every customer journey mapped (persona → journey → routes → cases,
  including negatives/empty/error paths) + a coverage matrix. Assembled from the per-domain catalogs.
- **`findings.md`** — bug / anomaly / UX-weirdness log with severity, repro, expected vs actual, and
  file refs. Includes a testid-gap list and a flakiness log.
- **`performance.md`** — per-route + per-server-action latency (p50/p95) from the serial perf pass,
  plus slow-query / N+1 flags and outliers.
- **`coverage-matrix.md`** — page × flow × persona × tested? grid.

The machine-readable roll-up is `apps/console/test-results/qa-report.json` (written by
`e2e/reporters/qa-reporter.ts`).

## Methodology

Approached as a QA team would: personas driving realistic journeys, then breadth (every page) +
depth (every mutation) + negatives (permission/validation/empty/error) + resilience (console/network
errors, a11y) + performance (latency capture). Tests run **live** against a dedicated QA console so
failures reflect real behavior, not mocks.

### Personas
- **ownerHobby** — free-tier org owner (default surface for read/nav specs).
- **ownerTeam** — Pro (card-less trial) org owner (billing/seats/paid surfaces).
- **member** — invited reduced-permission member (RBAC negative paths). *[added in a later step]*

### Test taxonomy
Smoke (page loads) · Journey (multi-step happy path with real mutations) · Negative
(validation/permission/empty/error) · Resilience (console/network-error + a11y) · Performance
(latency + slow-query capture).

## How to run

Prereqs: the dedicated QA console on `:3100` (see `scratchpad/qa-console.sh` in the plan session, or
the `qa-e2e-harness` memory) — same-origin auth, SES off so email-OTP logs. Backends via the normal
dev stack.

```bash
cd apps/console
# Full suite (Playwright owns parallelism against the one stack):
E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
  E2E_WORKERS=4 npx playwright test

# Single domain, serial (fast iteration; reuses persona sessions):
REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
  E2E_WORKERS=1 npx playwright test e2e/flows/<domain>.spec.ts

# Serial perf pass (clean p50/p95 — no load noise):
REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
  E2E_WORKERS=1 npx playwright test e2e/flows
```

Spec authoring contract: `apps/console/e2e/AUTHORING.md`.

## Environment notes (not product bugs)

The stock dev `.env` points the console's auth origin at an ngrok tunnel and configures SES, so a
headless email-OTP login on `localhost` fails (cross-origin OTP request) and the code is emailed
rather than logged. The QA console overrides both (same-origin + SES unset) purely to make headless
auth work — these are test-harness concerns, not console defects.
