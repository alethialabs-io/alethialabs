<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Console browser E2E (Playwright)

Browser-level end-to-end tests for the console, in nine Playwright projects. Two of them gate every
PR into `dev` (`hero`, `elench-ai`); seven of them are the legs of the **release gate**, the browser
check in front of every production deploy — see *The gate and the ratchet* below.

The one to read first is the **hero happy-path**: the sellable flow a human demos, driven end to end
in a headless Chromium, fully hermetically (no real cloud creds, no external email, no OAuth).

## The hero happy-path

`hero-happy-path.spec.ts` walks the whole sellable path:

1. **Sign in (email-OTP) → onboarding → create org** — the real auth flow (see the seam below).
2. **Org overview → "Get started" setup guide** — asserts the onboarding surface with its
   "Connect a cloud" step.
3. **Connect-a-cloud surface** (`/{org}/~/connectors`) — asserts the connector browser renders and
   a real cloud (AWS) is offered. Actually *verifying* a cloud needs real creds, so we assert the
   surface, not a live connection.
4. **Create a project** via **"Create empty project"** (name only — no cloud identity), which is
   what keeps this step hermetic and lands us on the design canvas.
5. **Design on the canvas** — opens the Add palette and drops a **Bucket** node.
6. **Reach the Deploy / pending-changes state** — asserts the staged-change bar with its **Deploy**
   CTA.
7. **Land on the evidence + clusters surfaces** — asserts their honest zero-data states.

### The honest boundary (please keep it honest)

The spec asserts we **reach** the Deploy / pending-changes state and that the **Deploy CTA is
present** — it does **not** click Deploy. Clicking Deploy queues real provisioning
(`applyStagedChanges → provisionProject`), which requires a **verified** cloud identity and would
then stand up real infrastructure. A truthful browser test stops here; it does not fake a `QUEUED`
job or a live cluster. The clusters surface at the end correctly shows *"No clusters provisioned"* —
that is the truth for a hermetic run that never deployed.

**To extend to an actual "DEPLOY job is QUEUED" assertion:** seed a *verified* `cloud_identity` for
the org (the "mocked/seeded connector"), select it in create-project's **Cloud** step, then click
**Deploy** and assert the queued job in `/{org}/~/jobs`. That seeding is intentionally out of scope
here — it couples the test to the connector/DB schema, and the client-side pending-changes boundary
is a cleaner, non-flaky stopping point.

## The hermetic auth seam

The console uses passwordless **email-OTP** (Better Auth). In dev/CI, SES is unconfigured, so
`@repo/email/send` logs the code instead of emailing it, on a single line:

```
[email] SES not configured — "…" → e2e-…@alethia.test (sign-in code: 123456)
```

- `helpers/otp.ts` scrapes that line from the console's stdout log. It matches **per recipient**
  (the email precedes the code on the same line), so parallel signups can never read each other's
  code, and it uses a **byte cursor** captured *before* requesting the code so a stale code is never
  picked up.
- `fixtures/auth.ts` → `signUpWithOtp(page)` drives `/signup` → email → OTP → `/onboarding` →
  create org, and returns the resolved `orgSlug`. It is the shared building block for both the hero
  spec (which runs it live as step 1) and the storageState setup.
- The log path defaults to `/tmp/alethia-dev-console.log` (what `pnpm dev:up` tees to) and is
  overridable with `DEV_CONSOLE_LOG` (CI points it at the teed `next start` output).

No real email, no OAuth, no external service — this log line is the only scraping seam, and it is
deterministic.

### Reusable persona `storageState`

`fixtures/auth.setup.ts` is a Playwright **setup project** that signs a persona in once and saves
the authenticated browser state to `e2e/.auth/persona.json` (gitignored). Any spec that only needs
an authed session — not the onboarding demo itself — can reuse it:

```ts
// playwright.config.ts
{
  name: "my-authed-suite",
  dependencies: ["setup"],
  use: { storageState: STORAGE_STATE },
}
```

The hero spec deliberately does **not** use it — signing in *is* the first act it demonstrates.

## Running locally

The tests need the console running with SES unconfigured (so the OTP is logged).

```bash
# 1. Bring up the console + backends (tees the console log to /tmp/alethia-dev-console.log)
pnpm dev:up

# 2. Run the hero path (Playwright reuses the dev:up server)
pnpm -F console exec playwright test --project=hero

# UI mode / all projects
pnpm -F console test:e2e:ui
```

When `CI` is unset, the `webServer` reuses the `pnpm dev:up` console. When `CI` is set, Playwright
boots the built console itself with `next start` and tees stdout to `$DEV_CONSOLE_LOG`.

## Which project runs where

Every spec here belongs to exactly one Playwright project, and every project is either invoked by a
workflow or explicitly marked as running nowhere. `playwright.config.ts` asserts both on **every**
invocation — including the two gating CI jobs — so a spec cannot be added into a hole again (#2875).

**Nothing runs nowhere any more.** The release gate (#4265) gave the last three projects a job, and
`LOCAL_ONLY_REASON` in `playwright.config.ts` is now empty. The table below is a reading of
`RUN_POSTURE` in that file, which the dead-zone guard checks against `.github/workflows/**` in both
directions — so where this table and the config disagree, the config is right and this file is stale.

| project | specs | where it runs |
|---|---|---|
| `setup` | `fixtures/auth.setup.ts` | dependency of `elench-ai`, `elench-live`, `canvas`, `audit`, `audit-interaction`; never invoked alone |
| `hero` | `hero-happy-path.spec.ts` | `ci.yml` → **E2E (browser · Playwright hero path)** · `release-gate.yml` → **Release gate (hero)** |
| `elench-ai` | `elench-ai.spec.ts`, `elench-ux.spec.ts` | `ci.yml` → **E2E (browser · Elench AI journeys · scripted model)** · `release-gate.yml` → **Release gate (elench-ai)** |
| `elench-live` | `elench-live.spec.ts` | `e2e-ai-nightly.yml` — real model, never gating |
| `canvas` | `architecture-canvas.spec.ts` | `release-gate.yml` → **Release gate (canvas)** |
| `console` | `account-settings`, `activity`, `billing`, `connectors`, `elench-agent`, `evidence`, `usage` | `release-gate.yml` → **Release gate (console)** |
| `qa` | `flows/*.spec.ts` | `release-gate.yml` → **Release gate (qa)** |
| `audit` | `audit/*.spec.ts` except `audit/destructive.spec.ts` | `ci.yml` → **UI conformance audit (console · non-required)**, nightly · `release-gate.yml` → **Release gate (audit)** |
| `audit-interaction` | `audit/destructive.spec.ts` | `release-gate.yml` → **Release gate (audit-interaction)** |

`hero` and `elench-ai` are twice-homed on purpose, and the `ci.yml` copies skip themselves on a PR
into `main` or `staging` (`github.base_ref`), so a promotion does not boot the same console twice.

The `ci.yml` hero job runs `--project=hero` off the fast path in its own parallel job: a
`postgres:17` service + `pnpm -F console db:migrate` (same as the Integration job), `pnpm -F console
build`, `playwright install`, then the spec. OpenFGA is left unset so the community
`PostgresRbacPDP` is the authz engine — no extra service needed. The Elench AI job is the same
shape with `ALETHIA_AI_MOCK=1`, and every release-gate leg is that recipe once more, per leg.

Running `pnpm -F console test:e2e` with no `--project` runs *everything*, `qa` included; pass
`--project=<name>` for anything narrower.

## The gate and the ratchet

`.github/workflows/release-gate.yml` is the browser gate in front of production. Production deploys
on a push to `main`, and `main` only ever takes a PR from `staging`, so a check on PRs into `main`
is "before every production deploy". It runs on a non-draft PR into `main` or `staging`, on a PR
into `dev` carrying the `release-gate:run` label, and on `workflow_dispatch` (with an optional
comma-separated `legs` input). Each leg boots its own ephemeral console — a Postgres service, the
real migrations, `pnpm -F @alethia/ee build`, `next start` — and drives one project against it.

**It is not guarding anything yet.** Measured 2026-09-09, this workflow, `gate-baseline.json` and
`scripts/e2e-ratchet.mjs` all live on `dev` alone — none of the three is on `origin/staging` or
`origin/main` — and the live `protect-main` ruleset requires none of the legs. `CONTRIBUTING.md`'s
promotion checklist has the detail; what follows is how the gate behaves, not what it currently
blocks.

**Every leg is green-by-ratchet, not green.** The suites were 39% green when the gate was built
(`apps/console/docs/qa/findings.md`, 2026-09-02), so an absolute-green requirement would have
blocked every promotion for weeks. Instead each leg fails on **regression** against
`gate-baseline.json`, which records one entry per (project, spec file, test):

| entry | means |
|---|---|
| `"passed"` | it passed, and must keep passing |
| `"failed"` | recorded debt — it may stay failing, and it may **not** start passing without a ledger move |
| `{"fixme": "BUG: <what> #<issue>"}` | a known bug parked behind `test.fixme`; it must stay skipped |
| `{"skip": "<why>"}` | a data-dependent condition; skipped **or** passed is fine, failed is not |

`scripts/e2e-ratchet.mjs` is what compares a run to it, and it is the only step in a leg that can
fail the job. The Playwright step itself carries `continue-on-error: true` — that is the ratchet
mechanism, not a softened check, because Playwright exits non-zero whenever any test fails and four
legs are expected to be red. The ratchet fails on a regression, on a new test that did not pass, on
a skip the ledger does not record, on a recorded failure that has started passing, on a run with
fewer tests than the baseline counts, and on a results file it cannot read at all. A separate
`--list` floor guard runs *before* the suite and fails hard, so `testMatch` drift cannot reach the
ratchet as a clean run of nothing.

**Fixing a test and moving the ledger are one PR.** The baseline is shrink-only, so a test that
starts passing while recorded as `failed` is a failure telling you to regenerate:

```bash
node scripts/e2e-ratchet.mjs --project=qa --results=apps/console/test-results/results.json \
  --write --only=flows/billing.spec.ts
```

`--only=<spec file>` replaces just that file's entries, so two lanes regenerating at once produce
diffs that touch their own files rather than colliding on the whole ledger. Never hand-edit
`gate-baseline.json`.

**The fixme rule.** A skip is recorded only if it states why. `test.fixme(true, "BUG: <what> #<n>")`
becomes a `{fixme}` and the description must match `BUG: … #<number>`; `test.skip(cond, "why")`
becomes a `{skip}`. A skip with no reason is refused rather than recorded — an unrecorded skip is
always a failure, which is the rule that closes the `HAVE_MEMBER` hole where an unset variable
turned every RBAC denial into a green skip for two months.

Do not pipe the ratchet into `head` or `tail`: a pipe reports the last command's exit code.

**A leg with no entry in the ledger fails, and one leg is in that state.** `gate-baseline.json`
carries six projects — `hero`, `elench-ai`, `console`, `canvas`, `qa`, `audit` — and the seventh,
`audit-interaction`, is not among them, because the baseline was captured (#4325) before that leg
existed (#4266). The ratchet reads an absent project as the bootstrap placeholder and fails with
"no baseline has been captured", deliberately: a gate that passes against an empty ledger is
vacuous. `Release gate (audit-interaction)` is therefore red until someone runs it once and commits
`node scripts/e2e-ratchet.mjs --project=audit-interaction --results=<json> --write`.

## Capabilities — `@needs:`

A capability is **promised by the leg, never detected by the spec**. The workflow sets
`ALETHIA_E2E_CAPABILITIES` per leg (`stripe`, `ai-mock`, or empty) and a spec declares what it needs
with a Playwright tag:

```ts
test("the trialing org shows its plan", { tag: "@needs:stripe" }, async ({ team }) => { … });
```

In CI a tagged spec on a leg that does not promise the capability is **red**, never a skip: the
leg's declaration and the spec's need disagree and one of them is wrong. Locally it skips with a
reason beginning `NOT MEASURED`, because a laptop with no Stripe keys is the normal case. A
misspelt promise raises rather than promising nothing.

The workflow also runs `e2e/helpers/capabilities.ts --assert-env` before the console build, so a
promised capability whose variables are absent is a named failure in seconds at the top of the job
rather than a downgraded run at the bottom. `helpers/capabilities.ts` owns both the capability list
and what each one requires; the authoring rules are in `AUTHORING.md`.
