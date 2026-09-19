# Console QA — coverage matrix

> **Measured 2026-09-18** by [release gate run 35390684972](https://github.com/alethialabs-io/alethialabs/actions/runs/35390684972)
> on #4623, head commit `7cbf6e8cf`: the run described at the top of `findings.md`. Each table is
> one leg, and its rows are the output of the gate's own ratchet for that leg:
>
> ```
> node scripts/e2e-ratchet.mjs --project=<leg> --results=<leg>/test-results/results.json --step-summary
> ```
>
> run against the leg's `release-gate-<leg>` artifact. Nothing here is hand-counted. The `personas`
> column is the one exception to "generated": it lists the fixtures each `qa` spec file's tests
> take, read from the spec source at the same commit. This file goes stale as soon as the tree
> moves. For the ledger's current totals, run `node scripts/e2e-ratchet.mjs --census`, which recounts
> `apps/console/e2e/gate-baseline.json` and never goes stale.

**739 tests in 7 legs and 42 spec files: 709 passed, 25 failed, 4 `fixme`, 1 data-dependent
skip.** Two of the 709 passed only on their retry.

Column meanings:

- **tests** is passed + failed + `fixme` + data-skip. It excludes the `setup` project's
  `fixtures/auth.setup.ts`, which the ratchet does not grade.
- **passed** includes the tests that passed only on their retry. **passed on retry** counts those.
- **`fixme`** is a skip the ledger records with a `BUG: … #<issue>` reason. **data-skip** is a
  skip the ledger records for a data-dependent condition.
- **not in ledger** counts tests `gate-baseline.json` did not record at this commit. The ratchet
  requires each of them to pass, and each did.

### `hero`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `hero-happy-path.spec.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

### `canvas`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `architecture-canvas.spec.ts` | 21 | 21 | 0 | 0 | 0 | 0 | 0 |

### `console`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `account-settings.spec.ts` | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| `activity.spec.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| `billing.spec.ts` | 3 | 0 | 3 | 0 | 0 | 0 | 0 |
| `connectors.spec.ts` | 6 | 6 | 0 | 0 | 0 | 0 | 0 |
| `elench-agent.spec.ts` | 10 | 8 | 2 | 0 | 0 | 0 | 1 |
| `evidence.spec.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| `usage.spec.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| **total** | **28** | **23** | **5** | **0** | **0** | **0** | **1** |

### `elench-ai`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `elench-ai.spec.ts` | 6 | 6 | 0 | 0 | 0 | 0 | 0 |
| `elench-ux.spec.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 0 |
| **total** | **13** | **13** | **0** | **0** | **0** | **0** | **0** |

### `audit`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `audit/permissions.spec.ts` | 31 | 31 | 0 | 0 | 0 | 0 | 0 |
| `audit/predicate-selftest.spec.ts` | 33 | 33 | 0 | 0 | 0 | 0 | 14 |
| `audit/routes.spec.ts` | 44 | 44 | 0 | 0 | 0 | 0 | 0 |
| **total** | **108** | **108** | **0** | **0** | **0** | **0** | **14** |

### `audit-interaction`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger |
|---|--:|--:|--:|--:|--:|--:|--:|
| `audit/destructive.spec.ts` | 72 | 71 | 1 | 0 | 0 | 0 | 0 |
| `audit/inert.spec.ts` | 41 | 41 | 0 | 0 | 0 | 0 | 41 |
| **total** | **113** | **112** | **1** | **0** | **0** | **0** | **41** |

### `qa`

| spec file | tests | passed | failed | `fixme` | data-skip | passed on retry | not in ledger | personas |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| `flows/_capabilities.spec.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | team |
| `flows/_persona-integrity.spec.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | **member**, team |
| `flows/_seed-smoke.spec.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/_smoke.spec.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/agent-usage-activity.negative.spec.ts` | 9 | 9 | 0 | 0 | 0 | 0 | 0 | owner, team |
| `flows/agent-usage-activity.spec.ts` | 21 | 21 | 0 | 0 | 0 | 0 | 0 | owner, team |
| `flows/alerts.negative.spec.ts` | 8 | 8 | 0 | 0 | 0 | 0 | 0 | **member**, owner, team |
| `flows/alerts.spec.ts` | 40 | 40 | 0 | 0 | 0 | 0 | 0 | team |
| `flows/billing.negative.spec.ts` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | owner, team |
| `flows/billing.spec.ts` | 33 | 24 | 6 | 3 | 0 | 1 | 0 | owner, team |
| `flows/connectors.negative.spec.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | **member**, owner, team |
| `flows/connectors.spec.ts` | 27 | 27 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/cross-cutting.negative.spec.ts` | 8 | 8 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/cross-cutting.spec.ts` | 62 | 61 | 0 | 1 | 0 | 0 | 0 | owner |
| `flows/deploy-jobs.negative.spec.ts` | 6 | 6 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/deploy-jobs.spec.ts` | 24 | 24 | 0 | 0 | 0 | 1 | 0 | owner |
| `flows/navigation-shell.negative.spec.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/navigation-shell.spec.ts` | 45 | 45 | 0 | 0 | 0 | 0 | 0 | **member**, owner, team |
| `flows/onboarding.negative.spec.ts` | 10 | 8 | 2 | 0 | 0 | 0 | 0 | owner, page, team |
| `flows/onboarding.spec.ts` | 31 | 27 | 3 | 0 | 1 | 0 | 0 | **member**, owner, page, team |
| `flows/projects.negative.spec.ts` | 10 | 10 | 0 | 0 | 0 | 0 | 0 | **member**, owner, team |
| `flows/projects.spec.ts` | 24 | 24 | 0 | 0 | 0 | 0 | 0 | owner |
| `flows/rbac.negative.spec.ts` | 5 | 5 | 0 | 0 | 0 | 0 | 0 | **member** |
| `flows/rbac.spec.ts` | 41 | 33 | 8 | 0 | 0 | 0 | 0 | owner, team |
| `flows/runners.negative.spec.ts` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | owner, team |
| `flows/runners.spec.ts` | 20 | 20 | 0 | 0 | 0 | 0 | 0 | team |
| **total** | **455** | **431** | **19** | **4** | **1** | **2** | **0** | |

## What the personas column means now

- **`owner`** (Hobby org) and **`team`** (Pro org) are the two org personas.
- **`member`** holds the built-in member role in the `team` org. Seven `qa` files use it.
  `_persona-integrity.spec.ts` proves the persona is real, and each negative file that uses it is
  fully green. On 2026-09-02, `alerts.negative.spec.ts` was the only member denial that measured
  anything.
- **`page`** is the raw fixture with no session: public routes and signup walks.

## Coverage notes

- **Deploy depth** stops at job QUEUED and uses `helpers/seed.ts` for the UI after a deploy. No
  OpenTofu, cloud or runner execution runs. `deploy-jobs.spec.ts` reaches the console again: 24/24.
- **Stripe runs in test mode** on the `qa`, `console` and `audit-interaction` legs. Real payment,
  real cloud credential checks, real email delivery and real provisioning are not covered, by
  design.
- **Not covered, by omission:** a `member` billing negative. `billing.negative.spec.ts` uses
  `owner` and `team` only.
- **One recorded skip outlived its issue.** The `fixme` on the evidence page's a11y scan in
  `flows/cross-cutting.spec.ts` names #4612, which is closed. Until the entry is deleted, that
  scan does not run. See `findings.md`.

## The 2026-09-02 matrix (superseded)

The previous version of this file transcribed the 2026-09-02 sandbox run: 346 tests in the `qa`
project only, 136 passed, 192 failed, 18 skipped or not run. That run is kept, superseded, in the
lower section of `findings.md`. Its per-file table is in this file's git history at `a15960d83`.
