# Console QA — end-to-end engagement

> **Re-baselined 2026-09-02 (#3633).** The suite was authored on 2026-07-05 and merged on 2026-08-23
> having never been executed against the console it ships beside. It has now been run, in full,
> against a real console: the numbers, the persona set and the per-domain triage in this directory
> describe **that run**, not the July one.
>
> Read `findings.md` first — it carries the date, the environment, the exact command, and the
> per-spec verdict. Every number in this directory is traceable to it. Nothing here is generated,
> so **anything you find with no run date beside it should be treated as unverified prose.**

This directory holds the deliverables of the exhaustive e2e QA pass over `apps/console`:

- **`flow-catalog.md`** — every customer journey mapped (persona → journey → routes → cases,
  including negatives/empty/error paths). Assembled from the per-domain catalogs. Describes what the
  specs *attempt*; `findings.md` says what they *do*.
- **`findings.md`** — the run ledger and the triage: what passed, what failed, and whether each
  failure is a product defect, spec drift, or a harness problem.
- **`performance.md`** — per-route + per-server-action latency (p50/p95) from a serial perf pass.
- **`coverage-matrix.md`** — spec file × tests × personas × measured result.

## The suite

26 spec files under `apps/console/e2e/flows/**` — 22 domain files (11 domains × a positive and a
`.negative` half) plus four harness ones (`_smoke`, `_seed-smoke`, `_persona-integrity`,
`_capabilities`).
`playwright test --project=qa --list` is the only authority on the **test** count: three earlier
documents in this directory each asserted a different one (320, 340, 307) and the tree held none of
them. A test count is not a file count, either — several files build their cases in a loop.

There is now a second, weaker authority worth knowing about: `apps/console/e2e/gate-baseline.json`
carries one entry per test the gate has actually observed, and it holds **384 for this project, 304
recorded `passed` and 80 recorded `failed`**. That is a recording of a real gate run, not a `--list`
of today's tree, so it goes stale the moment a spec is added and the ratchet is what re-reads it —
never cite it as the suite's size.

It is its own Playwright project, `qa`, and it is a **leg of the release gate** — `Release gate
(qa)`, by ratchet. See *Gate posture* below for what "by ratchet" buys and what it does not.

### Personas

All three are real accounts, created once per run by `e2e/global-setup.ts` and reused through
storageState. They are created **serially**: Better Auth caps OTP issuance at 5 sends / 60s
(`lib/config/auth.ts`), and with no trusted IP header in front of a sandbox env (#3789) that bucket
is shared by the whole install, not per client.

- **ownerHobby** — free-tier org owner (default surface for read/nav specs).
- **ownerTeam** — Pro org owner (billing/seats/paid surfaces). Onboarding takes the card-less trial
  where Stripe is configured and falls back to Hobby where it is not, so the org is granted a
  `team`/`active` billing record explicitly (see below).
- **member** — invited into ownerTeam's org with the built-in `member` role, through the product's
  own `organization/invite-member` → `accept-invitation` endpoints. **Built as of #3633.**

**Two things the member persona ran into, both measured, both still true:**

1. **Inviting is a paid feature enforced at the endpoint.** `app/api/auth/[...all]/route.ts` gates
   `invite-member` on the `organizations` entitlement, so an org resolving community entitlements
   gets `403 upgrade_required` — from the API, not from the dialog. `global-setup` therefore writes
   ownerTeam's org a `team`/`active` `organization_billing` row before inviting. That is a fixture,
   not a bypass: ownerHobby's org is untouched, so `rbac.spec.ts`'s community-vs-Pro ladder still
   measures the real refusal.
2. **A member with no access renders the org's 404 on every route** — and every negative asserting
   "the member cannot see X" then passes while measuring the 404.
   `flows/_persona-integrity.spec.ts` exists for exactly that: it proves the persona is a *distinct*
   live session, that it can load the org *normally*, and that it is refused something the **owner
   of the same org is not**. Restriction is a difference, never an absolute — an unentitled org
   refuses everybody. **Run it before believing any negative result in this directory.**

There is no `HAVE_MEMBER` environment gate any more. It used to guard the RBAC/permission negatives
with `test.skip(!process.env.HAVE_MEMBER)`, and an unset variable turned each of them into a green
skip. A missing persona now fails, loudly, in the fixture.

### Test taxonomy

Smoke (page loads) · Journey (multi-step happy path with real mutations) · Negative
(validation/permission/empty/error) · Resilience (console/network-error + a11y) · Performance
(latency capture).

## How to run

### In CI — the `Release gate (qa)` leg

This is where the suite runs for real, and it needs no box and no slot. It is a leg of
`.github/workflows/release-gate.yml`, which fires on a non-draft PR into `main` or `staging`, on a
PR into `dev` labelled `release-gate:run`, and on `workflow_dispatch`:

```bash
gh workflow run release-gate.yml --ref <branch> -f legs=qa
```

The leg boots its own console — a `postgres:17` service, `pnpm -C apps/console run db:migrate`,
`pnpm -F @alethia/ee build` (guarded, because without `ee/dist` the console falls back to community
scope and every org-scoped assertion goes vacuous), then `next start` under Playwright's
`webServer`. It sets `ALETHIA_QA_E2E=1` so `global-setup` builds the personas, promises the
`stripe` capability from the repo's test-mode secrets, and sets `ALETHIA_AUTH_RATE_LIMIT=0` — the
5-OTP/60s cap was the *recorded* reason this suite could not be gating, and removing it is what let
it in. It runs with `--workers=3 --retries=1`, and a `--list` floor refuses the leg if it reports
fewer than 300 tests.

Its report, traces and the `results.json` the ratchet read are uploaded as the
`release-gate-qa` artifact, 14-day retention.

### On the sandbox box — a full local pass

**Not on your Mac.** Sign-in scrapes the one-time code out of the console's stdout, and that log
only exists on the machine running the console (`.claude/skills/dev/SKILL.md`). So a hand-driven
pass runs on the sandbox box, against that box's own console.

```bash
pnpm env:up          # this branch gets a console, a database, a URL
pnpm env:push        # after editing — there is no hot reload
pnpm env:status      # confirm `scope: enterprise` (see below)
```

`pnpm env:test` does **not** export `ALETHIA_QA_E2E`, so it cannot start this suite: `global-setup`
returns immediately without it and every spec dies on a missing `personas.json`. Run it over ssh
with the variable set:

```bash
ssh root@<box> "
  cd /opt/alethia/envs/<slug>
  export DEV_CONSOLE_LOG=/var/log/alethia-<slug>.log
  export E2E_BASE_URL=https://<slot>-dev.alethialabs.io
  export ALETHIA_QA_E2E=1
  unset CI
  pnpm -F console exec playwright test --project=qa --workers=4
"
```

- `REUSE_AUTH=1` skips persona creation and reuses `e2e/.auth/` — use it for a second pass in the
  same environment, and only then. The personas are per-run accounts.
- A single domain: append `flows/<domain>.spec.ts`.
- The perf roll-up (`test-results/qa-report.json`) is written by `e2e/reporters/qa-reporter.ts`,
  which **`playwright.config.ts` does not register**. Ask for it explicitly:
  `--reporter=list,./e2e/reporters/qa-reporter.ts`. Without that flag the file this directory's
  performance numbers come from is never produced.

**The console must be serving `enterprise`.** A community-scoped console refuses a `team`/`active`
billing row with `403 upgrade_required`, so the member persona cannot be built and every
paid-entitlement assertion goes vacuous rather than failing. `pnpm env:status` measures the running
process, not `ee/dist` on disk — those two have come apart before (#3632).

Spec authoring contract: `apps/console/e2e/AUTHORING.md`.

## Gate posture

`qa` has a job. `RUN_POSTURE.qa` in `playwright.config.ts` now reads
`release-gate.yml · Release gate (qa)`, `LOCAL_ONLY_REASON` is empty, and `assertNoDeadZone()`
still checks that map against `.github/workflows/**` in both directions on every Playwright
invocation — so the posture is verified against the workflows, not asserted.

**The promotion bar is the ratchet, not a green suite.** #2417 is what happens when a large suite
becomes a merge gate unvalidated, and an absolute-green requirement here would have blocked every
promotion for weeks. So the leg fails on **regression** against `apps/console/e2e/gate-baseline.json`:
80 of this project's tests are recorded `failed` there, and the gate is satisfied as long as no
recorded pass regresses, no new test arrives red, no test is skipped without a recorded reason, and
no recorded failure has started passing without its ledger entry moving in the same PR. The rules
and the `--write --only=<file>` regeneration are documented in `apps/console/e2e/README.md`.

Two consequences worth stating plainly:

- **A green `Release gate (qa)` does not mean the QA suite passes.** It means "no worse than the
  ledger". `findings.md` is still where you read what is actually broken; the baseline is where you
  read what the gate has agreed to tolerate.
- **Fixing a spec without moving the ledger reds the gate.** That is deliberate — shrink-only means
  the ledger can never overstate debt, so the fix and the ledger move are one diff.

### What actually stops a bad promotion — nothing yet

Measured 2026-09-09: **the whole gate lives on `dev` and nowhere else.**
`.github/workflows/release-gate.yml`, `gate-baseline.json` and `scripts/e2e-ratchet.mjs` are all
absent from `origin/staging` and `origin/main`, and the live `protect-main` ruleset carries ten
required contexts, not one of which is a gate leg — `infra/github/variables.tf` declares them, but
that stack has never been applied (#4286 is the maintainer's `tofu apply`, which an absolute `deny`
rule refuses to agents).

So the two mechanisms below describe the promotion *after* this wave rides `dev → staging → main`,
not the one you would run today:

- **Branch protection**, once #4286 is applied: a red leg blocks the `staging → main` merge.
- **The deploy receipt**, once `deploy-console.yml` reaches `main` carrying it:
  `preflight` gates the whole deploy graph, resolving the merged `main` PR that contains the pushed
  commit and requiring the latest `Release gate (<leg>)` check-run for **every** leg on that PR's
  head to be `success`. The leg list is parsed out of `release-gate.yml`'s own `const legs` table,
  so it cannot drift from the gate. Its one escape hatch is a manual `workflow_dispatch` of
  *Deploy Console*, where the step is skipped by design.

A `pull_request` run resolves the workflow from the PR's **head**, so a `dev → staging` promotion
already fires the gate (`dev` has the file) while a `staging → main` promotion fires nothing until
that first promotion carries it across. The promotion checklist in `CONTRIBUTING.md` is where this
is stated for the person doing it.

## Production runs

The QA suite measures a *build*. It cannot measure the production configuration — the real Stripe
keys, the real OAuth redirect URIs, the real email sender, the real DNS and object storage. That is
layer 3: `/console-prod-qa` (`.claude/skills/console-prod-qa/SKILL.md`), a witnessed pass in the
maintainer's own Chrome over one QA organization, reversible mutations only, every destructive
dialog opened and cancelled.

Its reports live in `apps/console/docs/qa/prod-runs/` — one dated file per run, schema and index in
that directory's README. A production run appends to neither `findings.md` nor `coverage-matrix.md`;
those describe the Playwright suite and a later change reconciles them.
