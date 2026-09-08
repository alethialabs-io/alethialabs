# QA e2e authoring guide (read this before writing specs)

This suite exhaustively tests `apps/console` customer flows against a **live** console on
`http://localhost:3100` (a dedicated QA console: same-origin auth, SES off so OTP logs). Backends
(Postgres :5433, OpenFGA :8082) are shared and running.

## How to run a spec (ALWAYS use these env vars)

```bash
cd apps/console
REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
  E2E_WORKERS=1 E2E_RETRIES=0 npx playwright test e2e/flows/<your-file>.spec.ts
```

- **`REUSE_AUTH=1` is mandatory** — it reuses the already-created persona sessions and skips
  global-setup's OTP signups. Omitting it re-signs-up personas and races the shared OTP log across
  concurrent runs. Never omit it.
- Use `--grep` or a single file; keep `E2E_WORKERS=1` for self-checks.

## Import surface

```ts
import { test, expect } from "../fixtures/qa";
```

Fixtures (each is a fresh browser context on a persona storageState, with perf + console/network-error
collection auto-attached):

- `owner` — Hobby (free) org owner. `{ page, orgSlug, orgId, userId, guard, perf }`.
- `team` — Pro (card-less trial) org owner. Same shape. Use for billing/seats/paid-only surfaces.
- `member` — invited member (reduced perms), in the **`team` persona's org**. Same shape plus
  `role`. Built by `e2e/global-setup.ts` through the product's own `organization/invite-member` →
  `accept-invitation` endpoints (#3633), so it needs no gate: use it directly. The old
  `test.skip(!process.env.HAVE_MEMBER, …)` guard is **gone and must not come back** — an unset
  variable turned every permission denial it protected into a green skip. If the persona could not
  be built the fixture throws, which is the correct verdict.
  Before trusting a member-denial result, read `flows/_persona-integrity.spec.ts`: a member with no
  access renders the org 404 everywhere, so a denial only counts where the **owner of the same org**
  sees something different.

Route model: org-scope = `/${orgSlug}/~/<page>` (connectors, runners, jobs, alerts, agent, clusters,
usage, settings/{general,billing,members,teams,roles,access,sso,activity}); project-scope =
`/${orgSlug}/${projectSlug}/<page>` (architecture, environments, jobs, clusters, usage,
settings/activity). New project: `/${orgSlug}/~/new`.

## Preconditions via the seed helper (no real runner/cloud)

```ts
import { seedCloudIdentity, seedProject, seedFinishedDeploy, seedJob, seedDrift } from "../helpers/seed";
const id = { userId: owner.userId!, orgId: owner.orgId! };
const identity = await seedCloudIdentity(id, { provider: "aws" });         // connected cloud identity
const project = await seedProject(id, { cloudIdentityId: identity.id, status: "ACTIVE" });
await seedFinishedDeploy(project);   // clusters/DB ACTIVE + endpoints (mimics finalizeDeployment)
await seedJob(id, { jobType: "DEPLOY", status: "SUCCESS", projectId: project.projectId, envId: project.envId });
await seedDrift(project, { inSync: false, drifted: 2 });
```

Job status enum is `QUEUED|CLAIMED|PROCESSING|SUCCESS|FAILED|CANCELLED` (**SUCCESS**, not SUCCEEDED).

**Do NOT call `cleanupOrg` in `afterAll`.** The suite is `fullyParallel` and the persona org is
shared, so deleting its jobs, projects and cloud identities pulls the floor out from under every
other file still driving it — that is findings.md P0 §2, and `_seed-smoke.spec.ts` carries the
post-mortem. Seed uniquely-named rows instead (`e2e-<what>-${Date.now()}`) and leave them: the
personas are per-run accounts in a throwaway CI database, so nothing outlives the run.

## Conventions & rules

1. **Selectors**: `getByRole` (name via accessible text) → `getByLabel`/`getByPlaceholder` → `getByText`.
   Avoid brittle CSS. If a control has NO accessible handle, DON'T edit app code — record a
   "testid gap" finding (file + element) instead.
2. **Isolation**: create uniquely-named resources per test (`e2e-${Date.now()}`). Don't assume an
   empty org, and don't empty it — other specs share the persona org and run in parallel.
3. **Assertions**: 1–4 focused assertions per test; one concern per test. Use `await expect(...)`.
4. **Waits**: `await page.waitForURL(...)` for nav; `expect(locator).toBeVisible({ timeout })` for
   data. Don't use fixed sleeps.
5. **Coverage per domain**: happy path + negatives (validation errors, permission-denied for `member`),
   empty states, and at least one `expect(page).not.toHaveURL(/\/login/)` auth check. Where sensible add
   an a11y check: `import { scanA11y } from "../helpers/a11y"` (no-ops until axe is installed — fine).
6. **Console cleanliness**: for read-only page loads you may assert `owner.guard.expectClean()` — but
   many pages emit expected 401/analytics noise, so prefer recording (the reporter captures errors
   automatically) over failing on them, unless it's a clear 500 or uncaught error.
7. **Bugs**: when the APP misbehaves (500, broken flow, wrong copy, dead link), don't fight it — write
   the test to assert the CORRECT behavior (it will fail), mark it `test.fixme(true, "BUG: <desc>")`,
   and note it so triage can log it in `docs/qa/findings.md`.
8. **File layout**: `e2e/flows/<domain>.spec.ts` (+ `<domain>.negative.spec.ts` for permission/error
   paths). Use `test.describe("<Domain> — <journey>")`.
9. Never edit files outside `e2e/` and `docs/qa/`. Never commit. Never touch the user's WIP.

## What NOT to test end-to-end here
Real `tofu plan/apply/destroy` execution, live cloud credential verification, real Stripe charges,
real email delivery. Stop at "job QUEUED" or use the seed helper for post-deploy state.

## Capabilities — `@needs:` tags (promised, never detected)

A spec that needs Stripe (or the scripted model) declares it with a Playwright tag, and nothing else:

```ts
test("the trialing org shows its plan", { tag: "@needs:stripe" }, async ({ team }) => { … });
```

The leg that runs the spec PROMISES the capability in `.github/workflows/release-gate.yml`
(`ALETHIA_E2E_CAPABILITIES=stripe`), and `fixtures/qa.ts` enforces the tag through
`helpers/capabilities.ts`: in CI a tagged spec on a leg that did not promise is **red** — the tag and
the workflow disagree, and a red test is the honest report; locally it skips with a reason that begins
`NOT MEASURED`. Never write `test.skip(!process.env.STRIPE_SECRET_KEY)` — an unset variable turned 35
billing assertions into green skips, and `HAVE_MEMBER` did the same to every RBAC denial.

## The ratchet — `gate-baseline.json`

The release gate is green-by-ratchet. `scripts/e2e-ratchet.mjs` compares each leg's Playwright JSON
with `e2e/gate-baseline.json` and fails on a regression, a new test that does not pass, a skip that is
not a `fixme`, and — shrink-only — a recorded failure that now passes. So when your lane fixes tests:

```bash
node scripts/e2e-ratchet.mjs --project=qa --results=<downloaded results.json> --write --only=flows/<domain>.spec.ts
```

`--only=<file>` so your diff touches your files' entries and nobody else's; commit it **in the same
PR** as the fix. A known product defect is `test.fixme(true, "BUG: <what> #<issue>")` — the issue
number is required, and a plain `test.skip` is refused in CI.

## Seeds — one file per domain

`helpers/seed.ts` is owned by the seams and is not a lane's to edit. A domain that needs rows the shared
helper does not give it adds `helpers/seed-<domain>.ts` (precedent: `seed-alerts.ts`) and owns that
file. Two lanes editing `seed.ts` is how a stale column took 32 tests down with it.
