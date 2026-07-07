<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# PostHog — getting real value out of it

The console ships PostHog wired for **product analytics + session replay + web-vitals + funnels**
(EU cloud). This runbook is the "so what do I actually configure" half: the events the code now emits,
and the dashboards/funnels/cohorts to build in the PostHog UI so the data answers real questions.

Nothing here needs a deploy — it's all clicked in the PostHog project. The instrumentation that makes it
possible already lives in `apps/console/lib/analytics/*` + the call sites listed below.

## 0. Prerequisites (one-time)

- **Env**: `NEXT_PUBLIC_POSTHOG_KEY` (+ optional `NEXT_PUBLIC_POSTHOG_HOST`, default `https://eu.i.posthog.com`)
  set in the prod vault. The **same key** powers both the browser SDK and the server-side capture
  (`lib/analytics/server.ts`, used by the Stripe webhook) — no separate server key.
- **Identity is live**: on sign-in the app calls `identify(userId, {email,name})` and
  `group("organization", orgId, {name,slug,plan,role})` (see `components/analytics/analytics-identity.tsx`).
  This is what makes every funnel/retention/cohort *per-user and per-org* instead of anonymous.

## 1. Project settings (Settings → …)

- **Person display name**: set to `email` (so people are readable in lists/replays).
- **Session replay**: enable. Start at **100% sampling** while volume is low; add a **billing limit** so it
  can't surprise-bill. Inputs are masked (`maskAllInputs`) and sensitive nodes carry `data-ph-mask`
  (OTP code, billing card) — verify masking on a test replay before sharing.
- **Autocapture + heatmaps**: on (autocapture already is). Heatmaps need the toolbar authorized once.
- **Group analytics**: confirm an **`organization`** group type exists (it's created automatically the first
  time `group()` fires). Set its display name property to `name`.
- **Web Vitals**: PostHog captures these natively (`capture_performance`) — the built-in **Web Vitals**
  insight works out of the box; pin it to a dashboard (section 7).

## 2. The event catalog (what the code emits)

Source of truth: `apps/console/lib/analytics/events.ts`. Client events fire from the browser; revenue
events fire server-side from the Stripe webhook (so they're truthful even with no browser open).

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

`trial_started → upgrade_started → subscription_active`, plus a separate **trend** on
`subscription_canceled` and `payment_failed`. Filter/segment by the `organization` group to see paying vs
trialing orgs. (These are the server-side events, so they reflect Stripe truth, not client optimism.)

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
