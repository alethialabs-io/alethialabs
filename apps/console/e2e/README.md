<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Console browser E2E (Playwright)

Browser-level end-to-end tests for the console. The one that matters — and the one CI gates — is
the **hero happy-path**: the sellable flow a human demos, driven end to end in a headless Chromium,
fully hermetically (no real cloud creds, no external email, no OAuth).

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

| project | specs | where it runs |
|---|---|---|
| `setup` | `fixtures/auth.setup.ts` | dependency of `hero`-adjacent projects; never invoked alone |
| `hero` | `hero-happy-path.spec.ts` | `ci.yml` → **E2E (browser · Playwright hero path)** — required |
| `elench-ai` | `elench-ai.spec.ts`, `elench-ux.spec.ts` | `ci.yml` → **E2E (browser · Elench AI journeys · scripted model)** — required |
| `elench-live` | `elench-live.spec.ts` | `e2e-ai-nightly.yml` — real model, never gating |
| `canvas` | `architecture-canvas.spec.ts` | **nowhere yet** — needs a non-required job |
| `console` | `account-settings`, `activity`, `billing`, `connectors`, `elench-agent`, `evidence`, `usage` | **nowhere yet** — needs a non-required job |
| `qa` | `flows/*.spec.ts` | **nowhere yet** — see `apps/console/docs/qa/README.md` |

The `e2e-browser` job runs `--project=hero` off the fast path in its own parallel job: a
`postgres:17` service + `pnpm -F console db:migrate` (same as the Integration job), `pnpm -F console
build`, `playwright install`, then the spec. OpenFGA is left unset so the community
`PostgresRbacPDP` is the authz engine — no extra service needed. The `e2e-elench-ai` job is the same
shape with `ALETHIA_AI_MOCK=1`.

### The three that run nowhere

They are real specs against the current routes — not rot — but nothing executes them, so **nothing
here may be cited as coverage** until it has a job:

- **`canvas`** cannot simply be folded into `hero`: that project runs a *fresh* context (signing in
  is the hero spec's first act) and these need the `setup` persona's `storageState`.
- **`console`** specs each drive a full email-OTP signup. Better Auth caps OTP issuance at **5 per
  60s per IP** (`lib/config/auth.ts`), and at roughly a minute per signup seven of them would about
  double the hero job — so they cannot be poured into a gating check.
- **`qa`** is 320 tests never executed against the current console, and `global-setup.ts` does not
  create the `member` persona several of them require. It needs `ALETHIA_QA_E2E=1`.

Running `pnpm -F console test:e2e` with no `--project` runs *everything*, `qa` included; pass
`--project=<name>` for anything narrower.
