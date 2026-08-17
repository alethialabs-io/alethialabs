<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The MVP programme

**Read this first, every session.** It is the one file that answers _where is the programme, what is
proven, and what is next_ — so that nobody has to re-derive it by reading fifteen boards, and nobody
has to re-brief it after a context clear.

The programme is one sentence:

> Establish cloud parity across **hetzner · aws · gcp · azure · alibaba** for the full product
> capability surface, prove every demo scenario end-to-end on each cloud, and drive all of it through
> the `alethia` CLI — so the MVP is provably reached. Then, and only then, UI.

## How to rejoin it — four commands

```bash
git -C <the main checkout> pull --ff-only   # 1. hooks, CLAUDE.md AND this file load from app/,
                                            #    which is pinned to dev but never auto-pulled.
cat PROGRAMME.md                            # 2. intent, status, and the single mechanical next.
pnpm wt:who && scripts/coordinate.sh --report   # 3. who holds what; the live board delta.
scripts/claim-work.sh --issue <n>           # 4. claim. Never by hand.
```

Command 1 is first and it is not optional. A stale harness at least gets a SessionStart warning; a
stale **ledger** gets none, so reading this file out of an unpulled checkout means resuming the
programme as it stood days ago with nothing to tell you.

This file **ranks; it never claims.** The board claims, via `scripts/claim-work.sh`. If the
mechanical next names an issue that is closed or already claimed, that is a board fix — never a
reach-around to a different issue. If a cell has no issue at all, the first act is to decompose it
onto the board, because the ledger is not a work queue.

## §0 · What "MVP reached" means

Six predicates. They are written to be **checked by a script, not read as prose**, because the thing
that went wrong before was a board asserting a state the tree disagreed with.

1. **Capability parity is recorded, and the debt has a shrinking balance.** All three generated
   parity boards regenerate byte-identical, and every kind the product refuses on a cloud is either a
   documented ceiling with provider evidence or a debt item with an open issue.
2. **Every proof cell carries a real-apply proof.** For every (cloud × dimension) cell, the proof
   ledger's surviving claim must be a PASS whose bundle exists in the tree — never a green harness,
   never an expiring CI run tag.
3. **No `DeferredInProduct` cells remain** in `test/e2e/maxconfig.go` — the last product debt in the
   capability matrix.
4. **Driven from the CLI**: zero `CLIGap` verdicts, and a committed `cli-demo` proof row per cloud
   (the bar's real-binary half must actually have executed).
5. **Every demo scenario is asserted** — a set difference, both directions, between the runbook beats
   plus the per-cloud tutorial pages and the harness steps that assert them.
6. **Nothing is standing, and the boards are fresh** — the orphan reaper reports no leaks per cloud,
   and no board cites a closed issue as open.

**Declared ratchet ceilings** — human-set, machine-enforced, may only ever decrease:

| ratchet | ceiling | meaning |
| --- | --- | --- |
| `template_parity.baseline` | 301 | grandfathered asymmetric root variables |
| `cli_gap` | 0 | CLI debt is cleared and must stay cleared |
| `deferred_in_product` | 2 | hetzner registry→Harbor, secret→Vault |

## §1 · Ordering, and why this order

The phases below are **intent**. Their state is rendered under the marker; do not restate it here.

1. **Make the boards true.** A board that disagrees with the tree makes every later spend decision
   wrong, and correcting one costs nothing. This comes first even though it touches no cloud.
2. **Unblock the cadence.** Every later phase is a loop of _dispatch → read → fix_, so the loop's
   period is the programme's period. See decision D1.
3. **The floor, on all five clouds.** Nothing above the floor is measurable until a cloud provisions
   and converges at all.
4. **Parity ratchets** — fully parallel with 3 and 5, because per-cloud template trees are disjoint
   and touch no credential and no migration. This is where N-way agent parallelism actually lives.
5. **The full bar, per cloud, by dispatch** — blocked on a durable ledger and on that cloud's floor.
6. **Scenario layers, then the CLI bar** — one gate per dispatch, then unset it.
7. **The MVP predicate, then UI.**

## §2 · Standing decisions

Dated and numbered. Superseded in place, never deleted — a decision whose reasoning has been
overtaken is more useful than a gap.

- **D1 · 2026-08-17 · Real applies may federate from `dev` via a branch-restricted Environment.**
  The nightly's OIDC subjects pin `refs/heads/main`, but the work happens on `dev`, so every
  iteration otherwise serialises on a maintainer promotion — and promoting to `main` to iterate on a
  _test_ also ships the _product_ (release-please, the console and fleet deploys, the CLI release all
  trigger there). So: a GitHub Environment restricted to `dev`, trusted additionally by the e2e
  roles. `infra/aws-oidc` and `infra/azure-e2e` already support an `environment:` subject;
  `infra/gcp-e2e` and `infra/alibaba-e2e` need their scalar subject widened to a list.
  **The compensating control is load-bearing**: a branch-protection ruleset on `dev` requiring
  CODEOWNERS review for `.github/workflows/**` and `infra/**` only. Widening the trust is dangerous
  precisely because Mergify auto-lands PRs and CODEOWNERS is advisory off `main`; two globs remove
  that one path and leave every other lane autonomous. Required _reviewers_ stay off — that would
  reintroduce a human in every run, which is the thing being removed. The cron keeps its `main`-only
  ref subject, so scheduled spend does not widen at all.

- **D2 · 2026-08-17 · The parity axis is the 19 canvas `NodeKind`s; the proof axis is the 11
  provisionable kinds.** The 19 are what the product offers and what `alethia project component
  kinds` lists, with availability driven by one file
  (`apps/console/lib/cloud-providers/unsupported-kinds.ts`). The 11 are the subset a real apply can
  demonstrate in tofu state or as a named Application. The 18 marketplace add-ons are one dimension
  of the proof grid, not a third axis.

- **D3 · 2026-08-17 · All four cloud ceilings are in MVP scope.** Delegating a real DNS zone
  (registrar action) is the highest-leverage single action available: it is the only ceiling failing
  the CLI bar on every cloud, and it is what makes the certificate path provable at all. Hetzner's
  two deferred kinds close. The Azure full-bar quota is checked and raised if needed. Hetzner object
  storage keys and the GCP billing-budgets grant are obtained.

- **D4 · 2026-08-17 · The full bar is dispatch-only; no timer starts it.** The weekly cron fanned the
  whole 11-kind surface across five clouds while the pre-apply cost ceiling was wired for one, and
  bought a standing monthly prepaid resource on alibaba each week. A CI guard now fails the build if
  a scheduled cron resolves to the full bar unless every cloud in the matrix is priced — see #2385,
  which also tracks pricing the four unpriced clouds. Restoring a schedule is a per-cloud decision
  gated on that cloud being priced _and_ having a committed full-bar proof row.

## §3 · Anti-patterns

Each one is a mistake this repo has already paid for.

- **Never hand-edit below the marker.** Status is derived. `pnpm gen:programme` regenerates it, and
  CI diff-gates the result — a typed number is a number that will rot.
- **Never write status into the intent half.** The rollup greps for verdict glyphs, derived counts and
  "is green"/"is proven" phrasing, and fails the build. If it trips on a _definition_ rather than a
  claim, reword the definition imperatively ("every cell must carry a proof") rather than loosening
  the guard — the phrasing is cheaper to change than the protection. That grep
  is the only structural reason a sixteenth hand-maintained board cannot re-emerge inside this file.
- **Never promote a cell by asserting it.** A proof is a surviving ledger claim plus a bundle that
  exists. Four rows once claimed PASS on runs that had skipped at the gate, and had to be retracted.
- **Never correct a ledger row in place.** Append a `RETRACTED` row naming what it supersedes and the
  evidence that invalidates it. History is not rewritten.
- **Never widen a ceiling to clear a red.** A ceiling is a fact about a cloud. If a chart in this
  repo backs the capability, it is our debt and must read as debt.
- **Never re-derive programme state by exploring the tree.** That burns the context this file exists
  to save, and produces a second, unreviewed answer that will disagree with this one.
- **Never turn a cloud gate on from an agent session.** Enabling real spend is the maintainer's.
  Surface it and stop.

## §4 · What the generated half below does not know

Two things, deliberately, so that the half every PR diff-gates stays a pure function of the tree:

- **Whether a gate variable is actually set.** That needs a live query. A cell therefore never leaves
  `never-run` on the strength of a gate whose state is unknown.
- **Which issues are open.** So the generated half links issues but never asserts their state; the
  guard that a board may not cite a closed issue as open lives with the board that cites it.

<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->

## Where the programme actually is

**0 of 25 proof cells are proven.** 2 failing · 0 blocked · 23 never run.

A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.

### Proof grid — cloud × dimension

| cloud | floor | all kinds | 18 add-ons | BYO-IaC | day-2 |
|---|:---:|:---:|:---:|:---:|:---:|
| **aws** | ❌ | · | · | · | · |
| **gcp** | · | · | · | · | · |
| **azure** | · | · | · | · | · |
| **alibaba** | · | · | · | · | · |
| **hetzner** | · | · | ❌ | · | · |

Legend: ✅ proven · ❌ failing · ⛔ blocked · · never-run · — ceiling · 🔶 deferred

<details><summary>Every cell that has any evidence at all</summary>

- `aws/floor` **failing** — ledger 2026-07-22 (#1040)
- `hetzner/addons` **failing** — ledger 2026-08-05 (#2058)

</details>

### The mechanical next

**`aws/floor`** — failing. ledger 2026-07-22

Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs nothing new to re-drive, where a never-run cell needs its gate enabled first. This RANKS; it never claims — `scripts/claim-work.sh` claims.

<details><summary>The next 10</summary>

1. `aws/floor` — failing
1. `hetzner/addons` — failing
1. `gcp/floor` — never_run
1. `azure/floor` — never_run
1. `alibaba/floor` — never_run
1. `hetzner/floor` — never_run
1. `aws/maxconfig` — never_run
1. `gcp/maxconfig` — never_run
1. `azure/maxconfig` — never_run
1. `alibaba/maxconfig` — never_run

</details>

### Capability surface

**Proof grid (11 provisionable kinds × 5 clouds = 55 cells):** 48 carried by tofu · 3 carried in-cluster · 2 cloud ceilings · **2 deferred (our debt)**.

The deferred cells are the last **product** debt in the capability matrix — a chart this repo already ships backs the kind, and only the mapping is missing. They install on every full-bar run while the kind that would use them is refused:

- `hetzner/secrets` → chart **vault (marketplace catalog; the full-bar run already installs it)**
- `hetzner/registry` → chart **harbor (marketplace catalog; the full-bar run already installs it)**

Cloud ceilings (the cloud genuinely does not offer the kind — not our debt):

- `hetzner/topic`
- `hetzner/nosql`

**Parity grid (19 canvas NodeKinds × 5 clouds):** hetzner refuses 4 (topic, nosql, registry, secret); every other cloud backs all 19.

### Driven from the CLI

**19 steps CLI-driven · 0 CLI gaps (our debt) · 4 cloud ceilings · 1 console by design.**

The CLI debt is **zero** — every remaining blocker is a thing the cloud offers no API for, not a thing Alethia has not built. That distinction is the one worth carrying into a demo.

⚠️ Reachability only. The bar asserts the command surface resolves; it does **not** provision, and its real-binary half runs only when `E2E_CLI_DEMO` is set.

| step | verdict | clouds | issue |
|---|---|---|---|
| `hetzner-s3-keys` | cloud_manual | hetzner | #2332 |
| `dns-delegation` | cloud_manual | all | #1773 |
| `gcp-budget-publisher` | cloud_manual | gcp | #1871 |
| `alibaba-cr-sweep` | cloud_manual | alibaba | #2333 |

### Gate reality

Whether a dimension can run at all. A gate the workflow never mentions cannot be turned on by setting a variable.

| dimension | gate | referenced by the nightly? | what it proves |
|---|---|:---:|---|
| floor | `(the cloud gate alone)` | n/a | real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set |
| all kinds | `ALETHIA_E2E_MAX_CONFIG` | yes | every kind this cloud offers lands in tofu state (or converges as its named Application) |
| 18 add-ons | `ALETHIA_E2E_ALL_ADDONS` | yes | all 18 marketplace add-ons Healthy+Synced |
| BYO-IaC | `ALETHIA_E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN` | yes | customer IaC/charts applied, and Alethia services bound to their outputs |
| day-2 | `ALETHIA_E2E_SOAK / E2E_DAY2_ACCESS` | yes | a real access path beyond the soak — kubeconfig / ArgoCD surface |

Whether a gate is *set* is not knowable offline, so this file never claims it. It is reported in the live snapshot half, and a cell may not leave `never-run` on an unknown.

### Debt ratchets

| board | recorded debt |
|---|---|
| `infra/offer-exclusions.yaml` | exclusions: 25 · baseline: 0 · wired: 2 · carried_in_cluster: 2 |
| `infra/config-carriage-exclusions.yaml` | exclusions: 31 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/template-parity-exclusions.yaml` | exclusions: 0 · baseline: 301 · uniform: 10 |

### Provenance

Every number above is derived from these, and from nothing else:

- `test/e2e/generated/programme.json`
- `demos/proofs/provisioning-e2e-log.md`
- `.github/workflows/e2e-nightly.yml`
- `apps/console/lib/cloud-providers/unsupported-kinds.ts`
- `demos/proofs/<cloud>/<stamp>/`

Ledger rows read: **10** · surviving claims: **2** (a `RETRACTED` row voids a claim rather than replacing it, so surviving < rows is expected).

_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._

<!-- END GENERATED: programme-rollup -->
