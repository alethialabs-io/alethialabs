<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# PostHog — getting real value out of it

The console ships PostHog wired for **consented product analytics + optional session replay +
web-vitals + funnels** (EU cloud). Analytics and replay are separate choices and both default off.
This runbook is the "so what do I actually configure" half.

Nothing here needs a deploy — it's all clicked in the PostHog project. The instrumentation that makes it
possible already lives in `apps/console/lib/analytics/*` + the call sites listed below.

## 0. Prerequisites (one-time)

- **Env**: `NEXT_PUBLIC_POSTHOG_KEY` (+ optional `NEXT_PUBLIC_POSTHOG_HOST`, default `https://eu.i.posthog.com`)
  is set in the prod vault. It only configures the browser SDK; the SDK stays unloaded until consent.
- **Identity is minimized**: after analytics consent the app identifies only the internal user ID and
  groups by internal organization ID with `plan` and `role`. Email, personal name, organization name,
  and slug are not sent (see `components/analytics/analytics-identity.tsx`).
- **Server capture is disabled**: `lib/analytics/server.ts` preserves the call interface but sends no
  third-party event from webhooks or workers, where browser consent cannot be proven.

## 1. Project settings (Settings → …)

- **Person display name**: use the internal distinct ID; email and name are intentionally not collected.
- **Session replay**: enable only if the public replay purpose remains current. Start with conservative
  sampling and a billing limit. The app requires separate replay consent and masks all text and inputs;
  verify masking on a test account before allowing staff access.
- **Autocapture + heatmaps**: on (autocapture already is). Heatmaps need the toolbar authorized once.
- **Group analytics**: confirm an **`organization`** group type exists (it's created automatically the first
  time `group()` fires). Set its display name property to `name`.
- **Web Vitals**: PostHog captures these natively (`capture_performance`) — the built-in **Web Vitals**
  insight works out of the box; pin it to a dashboard (section 7).

## 2. The event catalog (what the code emits)

Source of truth: `apps/console/lib/analytics/events.ts`. Only consented browser events reach PostHog.
Rows marked server-side remain application events, but third-party capture is disabled.

| Event | Where | Key props |
|---|---|---|
| `signup_email_requested` | auth: request OTP | `mode` |
| `login_succeeded` | auth: OTP verified | `method` |
| `onboarding_plan_selected` | onboarding: plan tile | `plan` |
| `org_created` | onboarding: submit | `plan` |
| `connector_connect_started` | connectors: Connect | `provider`, `category` |
| `connector_connected` | connect verified (server-side probe) | `status` |
| `project_created` | new project | `provider`, `template` |
| `deploy_queued` | canvas: Deploy | `environmentId` |
| **`deploy_succeeded`** / **`deploy_failed`** | job lifecycle (terminal DEPLOY) | `provider`, `stage` |
| `member_invited` | invite dialog | `role` |
| `support_case_opened` | support submit | `category` |
| `trial_started` | create-org / onboarding trial | `plan` |
| `upgrade_started` | upgrade sheet / onboarding pay | `plan`, `context` |
| **`subscription_active`** | Stripe `invoice.payment_succeeded` (server) | `amount`, `currency`, `billing_reason` |
| `subscription_canceled` | Stripe `subscription.deleted` (server) | — |
| `payment_failed` | Stripe `invoice.payment_failed` (server) | `amount`, `currency` |

## 3. North-Star: the activation funnel (build this first)

**Insight → Funnel**, steps in order:
`org_created → connector_connected → project_created → deploy_queued → deploy_succeeded`
- **Conversion window**: 7 days.
- **Breakdown by**: group `organization` → property `plan` (see which plans activate).
- This is THE number: what fraction of new orgs reach a *successful deploy* (the value moment), and which
  step they fall off. `deploy_succeeded` (not `deploy_queued`) is the honest endpoint.

## 4. Acquisition funnel

`signup_email_requested → login_succeeded → org_created` — where sign-ups leak before they ever create an
org. (Anonymous pre-login events auto-alias onto the person once `identify()` runs, so this stitches across
the login boundary.)

## 5. Revenue funnel

`trial_started → upgrade_started` can be analyzed from consented browser events. Do not use PostHog as
the source of truth for `subscription_active`, `subscription_canceled`, or `payment_failed`: server-side
third-party capture is disabled. Use the billing database/Odoo for revenue truth.

## 6. Retention & cohorts (where replay pays off)

- **Retention insight**: returning event = **`deploy_succeeded`**, weekly. Answers "do orgs come back and
  keep deploying" — the real product-stickiness signal for a day-2 infra tool.
- **Cohorts** (People → Cohorts):
  - **Activated** — did `deploy_succeeded` (ever).
  - **Paying** — did `subscription_active`.
  - **Stuck** — did `connector_connected` **but not** `deploy_succeeded` in the last 7 days. ← highest-ROI:
    open **session replays filtered to this cohort** and watch where they stall (canvas? plan gate?
    permissions?). That's the fastest way to turn analytics into a fix.

## 7. Dashboards

- **North Star**: activation funnel (§3) + weekly-active orgs (unique `organization` on any event) + deploy
  **success rate** (`deploy_succeeded` / (`deploy_succeeded`+`deploy_failed`)) + trial→paid conversion.
- **Quality**: `deploy_failed` rate over time, `connector_connected` with `status != connected` (degraded),
  and the native **Web Vitals** p75 (LCP/INP/CLS) by route.

## 8. Alerts (optional but worth it)

- Alert on **deploy success-rate** dropping below a threshold (leading indicator of a provisioning
  regression).
- Alert on a `payment_failed` spike.

## 9. Next steps (not wired yet)

- **Feature flags**: PostHog flags are available (SDK loaded) but not yet used — good for gating rollout of
  new surfaces to the *Activated*/*Paying* cohorts.
- **Provider attribution on `connector_connected`**: the shared `useConnectionTest.run(save, meta)` accepts
  a `meta` arg — pass `{ provider }` from the per-cloud connection components to break the activation funnel
  down by cloud.

---

# Platform adoption — the rest of PostHog

The console now uses PostHog as more than analytics. Each capability is wired in code; this section is what
you configure/verify in the PostHog UI.

## 10. Session replay + surveys (why the project can look empty)

- **Enable replay**: **Settings → Session Replay → "Record user sessions"** must be **ON** — the SDK asks to
  record, but PostHog only stores replays if the project toggle is on. This is the usual reason "no replays"
  appear. Start at 100% sampling, add a billing limit, dial down as volume grows.
- **Reverse-proxy is live**: ingestion rides `alethialabs.io/ingest/*` (`next.config.ts` rewrites; browser
  `NEXT_PUBLIC_POSTHOG_HOST=/ingest`) so **ad-blockers no longer drop events** — the other reason a project
  looks empty. Verify: DevTools → Network shows POSTs to `/ingest/*` (not `eu.i.posthog.com`).
- **Surveys**: no code — build a survey in **Surveys**, and posthog-js auto-renders it to targeted users.
  Good for NPS / "why did you cancel" on the *Stuck*/canceled cohorts.

## 11. Error tracking (replaces Sentry)

After analytics consent, `capture_exceptions: true` catches unhandled client errors + promise rejections
and React error boundaries call `captureException(error, {boundary})`. Server exception capture is
deliberately disabled in `lib/analytics/server.ts`; operational errors remain in the first-party logging
stack. A replay is attached only where the user separately consented to replay.

## 12. LLM analytics (Elench, Ask-AI, verify, colony)

AI usage remains metered in the first-party billing database, but prompts, outputs, and `$ai_generation`
events are not sent to PostHog. Build cost and usage reporting from first-party aggregate records, with
access controls and retention appropriate to billing data.

## 13. Revenue analytics (Stripe) — Odoo stays the book of record

PostHog can show **MRR / ARR / churn / LTV** natively from Stripe, alongside our `subscription_active` /
`payment_failed` events — great for "do *activated* orgs convert, and which cohort churns." **This does not
replace Odoo** (ledger, invoices, VAT, statutory filing stay in Odoo). Setup (no app code):
1. In Stripe, create a **restricted API key** with **read-only** on Core/Billing (Customers, Subscriptions,
   Invoices, Charges, Products, Prices).
2. PostHog → **Data pipeline → Sources → Stripe** → paste the restricted key → sync.
3. Use **Revenue analytics** for MRR/churn, and join it against product cohorts (e.g. Activated → Paying
   conversion).

## 14. Feature flags & experiments

Wired: `lib/analytics/flags.ts` → `useFeatureFlag("key")` (React) + `isFeatureEnabled("key")` (imperative),
evaluated against the identified person + org group. To use: create a flag in **Feature flags**, target a
cohort (e.g. *Paying* orgs or a % rollout), then gate a surface with `const on = useFeatureFlag("new-x")`.
Promote to an **Experiment** to A/B against a metric (e.g. `deploy_succeeded`). Nothing is gated yet — the
helper is ready for the first rollout.

## 15. Cost control (set this once)

PostHog is usage-based with a monthly free tier (1M events, 5k replays, 1M flag requests). To stay
predictable: set a **billing limit** per product; keep **replay sampling** sane as traffic grows (the main
cost driver alongside autocapture); the reverse-proxy doesn't change cost, only capture rate.

## 16. Recurring errors → GitHub issue triage queue

Recurring PostHog error-tracking issues are auto-filed as GitHub issues you can then pick up and work
(e.g. in a Claude session). **Filing only — no automated LLM fix run** (that would cost per issue).

**`.github/workflows/posthog-error-issues.yml`** (cron every 6h + `workflow_dispatch`) runs
`scripts/posthog-error-issues.mjs`: queries the error-tracking issues API for active issues recurring
above `PH_MIN_OCCURRENCES` (default 10), dedups by a hidden `posthog-issue:<id>` marker in the issue
body, and files ONE issue each (labels `bug`, `from:posthog`; capped per run). SKIPS cleanly until the
secret exists, so it's safe to merge dark.

**Enable it — add these as GitHub Actions repo secrets** (Settings → Secrets and variables → Actions):

| Secret | What | Scope |
| --- | --- | --- |
| `POSTHOG_PERSONAL_API_KEY` | A PostHog **personal** API key (NOT the `phc_` ingestion key) | `error_tracking:read` + `query:read` |
| `POSTHOG_PROJECT_ID` | The project/environment id (PostHog → Settings → Project) | — |

Optional repo **variable** `POSTHOG_HOST` (default `https://eu.posthog.com`). Preview safely first: run the
filer via `workflow_dispatch` with `dry_run: true` (prints what it would file + the raw shape of the first
issue), or locally: `POSTHOG_PERSONAL_API_KEY=… POSTHOG_PROJECT_ID=… node scripts/posthog-error-issues.mjs --dry-run`.
Tune volume with `PH_MIN_OCCURRENCES` / `PH_MAX_ISSUES` / `PH_LOOKBACK_DAYS` in the workflow env. To work
the queue, filter issues by the `from:posthog` label and hand one to a Claude session.

## Deferred (not yet wired)

- **Marketing web analytics**: `apps/marketing` loads no PostHog, so the top-of-funnel (landing → signup)
  isn't captured. Follow-up: add a slim pageview-only init to marketing (promote the analytics layer to a
  shared `@repo` package) for GA-style web analytics.
