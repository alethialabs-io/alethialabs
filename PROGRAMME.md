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
| `deferred_in_product` | 0 | no kind is chart-backed-but-unwired on any cloud |

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

## §4 · How the live half stays honest

Two things cannot be derived from the tree — **whether a gate variable is set**, and **whether a cited
issue is still open**. Both now come from `docs/testing/programme-snapshot.json`, refreshed by
`.github/workflows/programme.yml` (which opens a PR; it never pushes) and carrying variable and secret
**names only, never values**.

The snapshot is a *committed file*, so everything downstream stays a deterministic function of the
tree and the PR diff gate never depends on a live GitHub read. Three rules keep it from lying:

- **`unknown` never collapses.** With no snapshot, a gate is not "unwired" and a red is not "stale" —
  a cell may not be reclassified on the strength of a file nobody fetched.
- **A closed citation is information, not a lint.** A cell whose last verdict is FAIL but whose issue
  is closed has had its cause fixed and needs a **re-run**, so it renders `stale` and ranks first — a
  re-run is the cheapest action available. The ledger row is append-only and is never rewritten: it
  was true when written; what was wrong was reading it as open work.
- **Staleness is an error eventually.** A broken refresh produces no signal at all, so the age lives
  in the snapshot: it warns past 48 hours and **fails past 7 days**.

A gate the workflow *derives from the dimension* (`ALETHIA_E2E_MAX_CONFIG`, `_ALL_ADDONS`, `_SOAK`)
is never reported unwired — there is no variable to set, and a dispatch reaches it. Only a gate a
maintainer must actually wire can be `unwired`, and a gate the workflow never mentions is
`no vehicle`, which is a different remedy.

<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->

## Where the programme actually is

**4 of 25 proof cells are proven.** 1 failing · 1 stale (cause fixed, needs a re-run) · 0 blocked · 19 never run.

A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.

### Proof grid — cloud × dimension

| cloud | floor | all kinds | 18 add-ons | BYO-IaC | day-2 |
|---|:---:|:---:|:---:|:---:|:---:|
| **aws** | ✅ | · | · | · | · |
| **gcp** | ✅ | · | · | · | · |
| **azure** | ✅ | · | · | · | · |
| **alibaba** | · | · | · | · | · |
| **hetzner** | ✅ | · | ♻️ | · | ❌ |

Legend: ✅ proven · ❌ failing · ⛔ blocked · · never-run · ♻️ stale · — ceiling · 🔶 deferred

<details><summary>Every cell that has any evidence at all</summary>

- `aws/floor` **proven** — ledger 2026-08-24, bundle `demos/proofs/aws/20260824T211529Z`
- `gcp/floor` **proven** — ledger 2026-08-25, bundle `demos/proofs/gcp/20260825T105829Z`
- `azure/floor` **proven** — ledger 2026-08-25, bundle `demos/proofs/azure/20260825T063447Z`
- `hetzner/floor` **proven** — ledger 2026-08-24, bundle `demos/proofs/hetzner/20260824T201636Z`
- `hetzner/addons` **stale** — ledger 2026-08-24 — but #2490 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix (#2490)
- `hetzner/day2` **failing** — ledger 2026-08-24

</details>

### The mechanical next

**`hetzner/addons`** — stale. ledger 2026-08-24 — but #2490 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix

Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs nothing new to re-drive, where a never-run cell needs its gate enabled first. This RANKS; it never claims — `scripts/claim-work.sh` claims.

<details><summary>The next 10</summary>

1. `hetzner/addons` — stale
1. `hetzner/day2` — failing
1. `alibaba/floor` — never_run
1. `aws/maxconfig` — never_run
1. `gcp/maxconfig` — never_run
1. `azure/maxconfig` — never_run
1. `alibaba/maxconfig` — never_run
1. `hetzner/maxconfig` — never_run
1. `aws/addons` — never_run
1. `gcp/addons` — never_run

</details>

### Capability surface

**Proof grid (11 provisionable kinds × 5 clouds = 55 cells):** 48 carried by tofu · 5 carried in-cluster · 2 cloud ceilings · **0 deferred (our debt)**.

Cloud ceilings (the cloud genuinely does not offer the kind — not our debt):

- `hetzner/topic`
- `hetzner/nosql`

**Parity grid (19 canvas NodeKinds × 5 clouds):** hetzner refuses 2 (topic, nosql); every other cloud backs all 19.

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

**Which clouds can provision at all.** A leg whose gate is unwired green-skips every night.

| cloud | gate | state |
|---|---|:---:|
| **aws** | `E2E_AWS_ROLE_ARN` | ? unknown |
| **gcp** | `E2E_GCP_WIF_PROVIDER` | ? unknown |
| **azure** | `E2E_AZURE_CLIENT_ID` | ? unknown |
| **alibaba** | `E2E_ALIBABA_ROLE_ARN` | ? unknown |
| **hetzner** | `HCLOUD_TOKEN` | ? unknown |

**Which dimensions can run.** A gate the nightly never mentions has no vehicle — setting a variable would not turn it on.

| dimension | gate | state | what it proves |
|---|---|:---:|---|
| floor | `(the cloud gate alone)` | n/a | real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set |
| all kinds | `ALETHIA_E2E_MAX_CONFIG` | ✅ by dimension: `ALETHIA_E2E_MAX_CONFIG` | every kind this cloud offers lands in tofu state (or converges as its named Application) |
| 18 add-ons | `ALETHIA_E2E_ALL_ADDONS` | ✅ by dimension: `ALETHIA_E2E_ALL_ADDONS` | all 18 marketplace add-ons Healthy+Synced |
| BYO-IaC | `E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN` | ? unknown: `E2E_ARGO_APPS_REPO`<br>? unknown: `E2E_GIT_TOKEN` | customer IaC/charts applied, and Alethia services bound to their outputs |
| day-2 | `ALETHIA_E2E_SOAK (dimension) / E2E_DAY2_ACCESS` | ✅ by dimension: `ALETHIA_E2E_SOAK`<br>? unknown: `E2E_DAY2_ACCESS` | a real access path beyond the soak — kubeconfig / ArgoCD surface |

### Open REDs

| cell | state | issue | issue state |
|---|---|---|:---:|
| `hetzner/addons` | stale | #2490 | ⛔ **CLOSED** |
| `hetzner/day2` | failing | **none** | ? |

♻️ **1 cell(s) cite a CLOSED issue**, so they are rendered `stale` rather than `failing`: the cause is fixed and what they need is a **re-run**, not a fix. They rank first in the mechanical next for exactly that reason — it is the cheapest action on the board.

The ledger row itself is not wrong and is not rewritten (it is append-only, and it was true when written). What was wrong was reading it as open work — the same defect that had the parity board citing four closed issues as live floor blockers.

### Blocked on a human

- #2485 — prod: the console has not deployed since 2026-07-30 — a cross-app import in the pruned image build, masked by fail-fast behind an expired PostHog key
- #2482 — release: the console never learns about a new CLI version — the notification's credentials cannot mint from a tag
- #2465 — programme: two of the six MVP predicates assert something no script can check
- #2462 — infra(e2e): make the e2e-dev OIDC trust widening authoritative — four applies, currently hand-applied
- #2283 — probe(alibaba-cr): does an AUTO scan rule fire with no VPC endpoint? (#2265 shipped the wiring, not the proof)
- #2259 — e2e nightly: azure RED (floor)
- #2258 — e2e nightly: gcp RED (floor)
- #2099 — e2e nightly: gcp RED (full-bar)
- #1871 — fix(gcp-e2e): the billing budget's alerts are undeliverable — the publisher binding cannot be created
- #1773 — e2e: delegate a real zone so the full bar can prove the ACM/cert path
- #1720 — e2e nightly: 1 of 5 clouds are not enabled
- #1579 — e2e nightly: wire the hetzner gate (HCLOUD_TOKEN — no stack)
- #1513 — feat(keyless): GA — default-on rollout and delete ALETHIA_KEYLESS_DB_AUTH_ENABLED
- #1450 — test(e2e): azure-mysql keyless real-apply on Azure (main-gated)
- #1268 — test(e2e): cross-account keyless cloud-SM in-cluster read — AWS/GCP/Azure/Alibaba (main-gated)
- #1065 — feat(e2e): P2-C all-19-add-ons Healthy+Synced on GCP + Azure
- #845 — test(fabric): W-h prove enterprise-demo on all 4 partner clouds (acceptance gate)

### Debt ratchets

| board | recorded debt |
|---|---|
| `infra/offer-exclusions.yaml` | exclusions: 25 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/config-carriage-exclusions.yaml` | exclusions: 31 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/template-parity-exclusions.yaml` | exclusions: 0 · baseline: 301 · uniform: 11 |

### Provenance

Every number above is derived from these, and from nothing else:

- `test/e2e/generated/programme.json`
- `demos/proofs/provisioning-e2e-log.md`
- `.github/workflows/e2e-nightly.yml`
- `scripts/e2e/resolve-dimension.sh`
- `apps/console/lib/cloud-providers/unsupported-kinds.ts`
- `demos/proofs/<cloud>/<stamp>/`
- `docs/testing/programme-snapshot.json`

Live board snapshot: taken **2026-08-25T11:47:25Z** — refreshed by `.github/workflows/programme.yml`, which opens a PR rather than pushing. Warns past 48h, fails past 7 days.

The timestamp is printed VERBATIM from the snapshot, never as an age. An age is computed from the current clock, so it would drift with no change to any input and make this diff-gated region stale an hour after every refresh — redding CI for everyone. The clock is only ever used to FAIL on a snapshot older than 7 days, which is a deliberate exception: a refresh that has silently stopped produces no other signal.

Ledger rows read: **20** · surviving claims: **6** (a `RETRACTED` row voids a claim rather than replacing it, so surviving < rows is expected).

_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._

<!-- END GENERATED: programme-rollup -->
