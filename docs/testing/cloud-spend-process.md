<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Spending money on a cloud test run

Every control this page describes **already exists and is already enforced**. Nothing here is
aspirational. What was missing was one page saying how they fit together, so that deciding to spend
money does not mean reconstructing the answer from five files' header comments.

Read this before dispatching anything that provisions real infrastructure. For *how to enable a
cloud at all* — credentials, per-cloud configuration, regions — see
[`e2e-nightly-enablement.md`](./e2e-nightly-enablement.md). That is the enablement page; this is
the spend page.

**This page is not permission.** Turning a cloud gate on, or restoring a schedule, is the
maintainer's act and nobody else's — `PROGRAMME.md` §3, *"Never turn a cloud gate on from an agent
session. Surface it and stop."*

**And it carries no status.** Which cells are proven, which clouds are priced, and what the reaper
last saw are all derived into `PROGRAMME.md`'s generated half, which regenerates. A number typed
here would rot, and a second board disagreeing with the first is exactly what `PROGRAMME.md` §1's
first phase exists to prevent. Everything below links; nothing restates.

---

## 1 · One correction, first, because the name misleads

**`ResolveT2Budget` is a TIME budget, not a spend budget.**

`test/e2e/t2_budget.go` computes a timeout ladder — `ctx < go-timeout < step-cap < job-cap` — so the
in-process context cancels before Go's own timeout, before the GitHub Actions step cap, before the
job cap. `cmd/t2budget` hard-fails the leg *at step start* if the workflow's caps cannot contain the
derived ladder.

That is a real and useful control, and it is not a cost ceiling. Reading the name as one and
concluding that spend is bounded per run is a mistake that has already been made in a handoff. The
money control is §3.

---

## 2 · Cheapest signal first

The ordering is not a style preference; it is what keeps a mistake cheap.

1. **Nothing.** Most questions are answered by the tree, a unit test, or `--self-test` on the guard
   that already models the thing. Fix the instrument before paying for a run.
2. **The floor**, one cloud. A small cluster, provisioned and torn down. This is the smoke test, and
   a cloud that cannot pass it cannot tell you anything about the dimensions above it.
3. **One dimension, one cloud, on a watched dispatch.** Not a matrix. Not unattended.
4. **The full bar** — `ALETHIA_E2E_MAX_CONFIG` + `ALETHIA_E2E_ALL_ADDONS`, 11 kinds and 18 add-ons.
   Heavy. Per cloud, and only for a cloud that is priced.

Dimensions are resolved in exactly one place, `scripts/e2e/resolve-dimension.sh`, whose
`--self-test` cross-checks the workflow's dispatch options against the dimension list **in both
directions** — so an implemented dimension cannot be unselectable and a stale option cannot linger.
Do not add a second list anywhere.

**No cron fires the full bar.** That is a standing decision (`PROGRAMME.md` §2 D4) taken after a
weekly cron fanned the whole surface across five clouds while the cost ceiling was wired for one,
and bought a standing monthly prepaid resource on alibaba every week. Restoring a schedule is a
per-cloud decision, gated on that cloud being priced *and* having a committed full-bar proof row.

---

## 3 · The ceiling, and the trap that comes with it

`packages/core/provisioner/cost_ceiling.go` compares an Infracost estimate of the plan against
`ALETHIA_COST_CEILING_MONTHLY_USD` **before** the apply, and it is **fail-closed**:

| ceiling | estimate | result |
|---|---|---|
| `<= 0` or unset | — | guard disabled (the default for real customer applies) |
| `> 0` | none produced | **BLOCKED** — "refusing to apply an unpriced plan" |
| `> 0` | over the ceiling | **BLOCKED** |

### Prove the estimate, then wire the ceiling — never the other way round

Because it fail-closes when *no estimate is produced* — a missing `INFRACOST_API_KEY`, or pricing
that did not run — **wiring a ceiling for a cloud whose estimate has never been produced converts a
spend risk into a red leg**, on exactly the floors the programme needs green. So the order per
cloud, which #2385 tracks:

1. Confirm `infracost breakdown` produces a `Summary` for that cloud's plan **at all**.
2. Only then wire that cloud's ceiling variables.
3. Only then move it out of `UNPRICED_EXEMPTIONS`.

Today the ceiling is wired for **aws** and resolves to `''` — disabled — for gcp, azure, alibaba and
hetzner. That is a deliberate, recorded state, not an oversight.

### A monthly-USD ceiling cannot see a prepaid resource

alibaba's `infra/templates/project/alibaba/modules/cr` creates `alicloud_cr_ee_instance` with
`payment_type = "Subscription"`, bought **per run** because `instance_name` carries the environment.
A monthly rate ceiling is structurally blind to it. The control that matters there is the sweep
failing on a survivor — not a dollar figure — which is why alibaba's entry in `UNPRICED_EXEMPTIONS`
says so rather than pretending a ceiling would help.

### The guard that stops this regressing

`scripts/check-e2e-spend-guard.mjs` runs in CI and enforces, in both directions, that a **scheduled**
run resolving to the full bar fails the build unless every cloud in the scheduled matrix is priced
or carries a declared exemption. An exemption is an accepted risk on a *dispatched, watched* run and
deliberately does **not** satisfy the scheduled rule.

---

## 4 · Teardown is verified, not assumed — and today it is assumed

Be exact about what each layer asks, because the difference is the gap.

| layer | where | what it actually asks |
|---|---|---|
| cancellation sweep | `e2e-nightly.yml`, `if: cancelled()` | runs the cleanup **first** in the shared 4m45s cancellation budget |
| guaranteed teardown | `e2e-nightly.yml`, `always()` | runs the per-cloud sweep; **refuses to run unscoped** |
| outcome assertion | `scripts/e2e/nightly-rollup.sh`, `teardown_outcome()` | **did the step report a conclusion** — `done` / `UNSWEPT` / `unknown` |
| out-of-band reclaim | `e2e-orphan-reaper.yml` | re-lists the cloud, daily, on its own schedule |

The cancellation layer exists because a cancelled job gets **one shared 4m45s budget** for every
remaining `always()` step, and the late teardown step used to lose that race — run `31459117502`
left roughly $105/month standing.

`teardown_outcome()` is good and is deliberately **orthogonal to PASS/FAIL**: a green provisioning
leg can still be reported "possibly billing", because provisioning and cleanup are different claims.
An empty or `cancelled` step conclusion — the fingerprint of a worker killed mid-sweep — reads
`UNSWEPT`.

**But it reads a step conclusion, not the cloud.** A sweep that exits 0 having silently failed to
discover a resource reads `done`. The only thing that re-lists the account is the reaper, hours
later and out of band. There is no synchronous, in-run, scoped "prove zero resources remain for this
run" pass — that gap is **#4398**.

### Never account-wide

The guaranteed-teardown step hard-errors when `E2E_CLUSTER`/`E2E_ENV` is unset rather than skipping,
and any verification added later must keep that property. `demos/proofs/README.md` §*"Teardown is
guaranteed — and never account-wide"* has the reasoning. A cleanup that widens its own scope to be
sure is worse than one that refuses.

### What "nothing standing" is worth

`PROGRAMME.md` §0 predicate 6 is *"Nothing is standing"*, answered per cloud by the reaper. The cost
of getting it wrong is not mainly the invoice: two AWS environments that survived teardown ran at
about **$1/month** and held **2 of the 5 `us-east-1` VPCs**, walling off every future run on that
cloud. Read a residual as a quota wall, not a line item.

---

## 5 · Release the slot

Two different things bill, and both bill by **existing** rather than by being used.

- **The sandbox box** — `pnpm env:reap` when you are finished with a branch; `pnpm env:timer`
  installs an idle reap. A box left up costs about €69.49/mo against €0.72 reaped. `env:reap`
  refuses while somebody else's environment is live, and waits for an idle threshold unless you pass
  `--now`.
- **Cloud test infrastructure** — the reaper, plus whatever the run's own teardown removed.

Neither is reclaimed automatically beyond those mechanisms, and nothing else will notice.

---

## 6 · Before you dispatch — the short version

- Is the question answerable without spending? Fix the instrument first.
- Is this the cheapest dimension that could answer it?
- Is the cloud **priced**, if this is a full bar? If not, is it a watched dispatch with an
  exemption, and are you actually watching?
- Is it one cloud, or did you just matrix five?
- After it finishes: did teardown report `done`, and did the next reaper run agree?

## Related

- [`e2e-nightly-enablement.md`](./e2e-nightly-enablement.md) — enabling a cloud; per-cloud
  configuration and the region traps
- [`maintainer-unblock-checklist.md`](./maintainer-unblock-checklist.md) — what only the maintainer
  can unblock
- `PROGRAMME.md` — the proof grid, gate reality and the reaper's live state, all generated
- #2385 pricing the four unpriced clouds · #4398 synchronous teardown verification · #4395 the
  reaper's evidence reaching the ledger
