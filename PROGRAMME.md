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
  `infra/alibaba-e2e`'s trust was verified live on 2026-08-27 and is ALREADY a list, admitting
  both `ref:refs/heads/main` and `environment:e2e-dev`; `infra/gcp-e2e` still needs its scalar
  subject widened.
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

**10 of 30 proof cells are proven.** 4 failing · 4 stale (cause fixed, needs a re-run) · 0 blocked · 9 never run.

A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.

### Proof grid — cloud × dimension

| cloud | floor | all kinds | 18 add-ons | GitOps repos | BYO-IaC | day-2 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **aws** | ⚠️ | ✅ | ❌ | ♻️ | · | ❌ |
| **gcp** | ⚠️ | ♻️ | · | ✅ | · | ✅ |
| **azure** | ⚠️ | ♻️ | ❌ | ✅ | ✅ | ✅ |
| **alibaba** | · | · | · | · | · | · |
| **hetzner** | ✅ | ♻️ | ❌ | ✅ | ✅ | ✅ |

Legend: ✅ proven · ❌ failing · ⛔ blocked · · never-run · ♻️ stale · ⚠️ contested · — ceiling · 🔶 deferred · 💰 cost

<details><summary>Every cell that has any evidence at all</summary>

- `aws/floor` **contested** — ledger 2026-08-24, bundle `demos/proofs/aws/20260824T211529Z` — but #3042 is OPEN and was filed 2026-08-27, AFTER the 2026-08-24 run that proved it
- `aws/maxconfig` **proven** — ledger 2026-08-26, bundle `demos/proofs/aws/20260826T114712Z`
- `aws/addons` **failing** — ledger 2026-08-26 (via the `full` composite run) (#2717)
- `aws/gitops` **stale** — ledger 2026-08-26 — but #2591 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix (#2591)
- `aws/day2` **failing** — ledger 2026-08-26 (#2717)
- `gcp/floor` **contested** — ledger 2026-08-25, bundle `demos/proofs/gcp/20260825T105829Z` — but #2743 is OPEN and was filed 2026-08-26, AFTER the 2026-08-25 run that proved it
- `gcp/maxconfig` **stale** — ledger 2026-08-27 — but #2811 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix (#2811)
- `gcp/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/gcp/20260825T200519Z`
- `gcp/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/gcp/20260825T210602Z`
- `azure/floor` **contested** — ledger 2026-08-25, bundle `demos/proofs/azure/20260825T063447Z` — but #3043 is OPEN and was filed 2026-08-27, AFTER the 2026-08-25 run that proved it
- `azure/maxconfig` **stale** — ledger 2026-08-27 — but #2905 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix (#2905)
- `azure/addons` **failing** — ledger 2026-08-25 (via the `full` composite run)
- `azure/gitops` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T210320Z`
- `azure/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T204358Z`
- `azure/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T235236Z`
- `hetzner/floor` **proven** — ledger 2026-08-27, bundle `demos/proofs/hetzner/20260827T192915Z`
- `hetzner/maxconfig` **stale** — ledger 2026-08-25 (via the `full` composite run) — but #2568 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix (#2568)
- `hetzner/addons` **failing** — ledger 2026-08-27 (#2717)
- `hetzner/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/2026-08-25T175213Z`
- `hetzner/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/hetzner/20260827T210204Z`
- `hetzner/day2` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/20260825T192100Z`

</details>

### The mechanical next

**`gcp/maxconfig`** — stale. ledger 2026-08-27 — but #2811 is CLOSED, so the cause is fixed and this needs a fresh run, not a fix

Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs nothing new to re-drive, where a never-run cell needs its gate enabled first. This RANKS; it never claims — `scripts/claim-work.sh` claims.

<details><summary>The next 10</summary>

1. `gcp/maxconfig` — stale
1. `azure/maxconfig` — stale
1. `hetzner/maxconfig` — stale
1. `aws/gitops` — stale
1. `aws/floor` — contested
1. `gcp/floor` — contested
1. `azure/floor` — contested
1. `aws/addons` — failing
1. `azure/addons` — failing
1. `hetzner/addons` — failing

</details>

### Capability surface

**Proof grid (11 provisionable kinds × 5 clouds = 55 cells):** 47 carried by tofu · 5 carried in-cluster · 2 cloud ceilings · **0 deferred (our debt)** · 1 excluded by cost.

Excluded by **cost** — the cloud offers the kind and the product ships it, but provisioning it in the harness would buy something not billed by the hour. These are spend decisions, not capability limits, and the price is printed so the decision can be re-taken rather than inherited:

- `alibaba/registry` → alicloud_cr_ee_instance — 150 USD/month (Basic, eu-central-1; 1800/year, no term discount; Advanced 617; no tier below Basic), bought PER RUN because instance_name carries the environment

Cloud ceilings (the cloud genuinely does not offer the kind — not our debt):

- `hetzner/topic`
- `hetzner/nosql`

**Parity grid (19 canvas NodeKinds × 5 clouds):** hetzner refuses 2 (topic, nosql); every other cloud backs all 19.

### Driven from the CLI

**23 steps CLI-driven · 0 CLI gaps (our debt) · 4 cloud ceilings · 1 console by design.**

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

| cloud | gate | state | evidence |
|---|---|:---:|---|
| **aws** | `E2E_AWS_ROLE_ARN` | ✅ wired | a leg reached the gate — run 33095437088 |
| **gcp** | `E2E_GCP_WIF_PROVIDER` | ✅ wired | a leg reached the gate — run 33107356336 |
| **azure** | `E2E_AZURE_CLIENT_ID` | ✅ wired | a leg reached the gate — run 33080748841 |
| **alibaba** | `E2E_ALIBABA_ROLE_ARN` | ✅ wired | a leg reached the gate — run 33080748841 |
| **hetzner** | `HCLOUD_TOKEN` | ✅ wired | a leg reached the gate — run 33107342500 |

**Which dimensions can run.** A gate the nightly never mentions has no vehicle — setting a variable would not turn it on.

| dimension | gate | state | what it proves |
|---|---|:---:|---|
| floor | `(the cloud gate alone)` | n/a | real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set |
| all kinds | `ALETHIA_E2E_MAX_CONFIG` | ✅ by dimension: `ALETHIA_E2E_MAX_CONFIG` | every kind this cloud offers lands in tofu state (or converges as its named Application) |
| 18 add-ons | `ALETHIA_E2E_ALL_ADDONS` | ✅ by dimension: `ALETHIA_E2E_ALL_ADDONS` | all 18 marketplace add-ons Healthy+Synced |
| GitOps repos | `E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN` | ✅ wired: `E2E_ARGO_APPS_REPO`<br>✅ wired: `E2E_GIT_TOKEN` | a customer apps-destination repo and a BYO Helm chart converge, and each manages at least one real resource |
| BYO-IaC | `ALETHIA_E2E_BYO_IAC` | ✅ by dimension: `ALETHIA_E2E_BYO_IAC` | a customer OpenTofu root module is refused when unsafe, applied through the state proxy, drifts, heals and destroys — with state cleared |
| day-2 | `ALETHIA_E2E_SOAK (dimension) / E2E_DAY2_ACCESS` | ✅ by dimension: `ALETHIA_E2E_SOAK`<br>✅ wired: `E2E_DAY2_ACCESS` | a real access path beyond the soak — kubeconfig / ArgoCD surface |

### Open REDs

| cell | state | issue | issue state |
|---|---|---|:---:|
| `aws/addons` | failing | #2717 | open |
| `aws/gitops` | stale | #2591 | ⛔ **CLOSED** |
| `aws/day2` | failing | #2717 | open |
| `gcp/maxconfig` | stale | #2811 | ⛔ **CLOSED** |
| `azure/maxconfig` | stale | #2905 | ⛔ **CLOSED** |
| `azure/addons` | failing | **none** | ? |
| `hetzner/maxconfig` | stale | #2568 | ⛔ **CLOSED** |
| `hetzner/addons` | failing | #2717 | open |

♻️ **4 cell(s) cite a CLOSED issue**, so they are rendered `stale` rather than `failing`: the cause is fixed and what they need is a **re-run**, not a fix. They rank first in the mechanical next for exactly that reason — it is the cheapest action on the board.

The ledger row itself is not wrong and is not rewritten (it is append-only, and it was true when written). What was wrong was reading it as open work — the same defect that had the parity board citing four closed issues as live floor blockers.

### ⚠️ Contested — proven by the ledger, contradicted by an open red

A nightly that goes red files an **issue** and writes **no ledger row**. So from the ledger's point of view that failure never happened, and a cell proven earlier stays ✅ forever: PASS is durable, a later FAIL is invisible. That makes the grid a **high-water mark** presented as current state, in the one direction that overstates — which is the thing this whole file exists to prevent.

| cell | proven by a run dated | open red | filed |
|---|:---:|---|:---:|
| `azure/floor` | 2026-08-25 | #3043 | 2026-08-27 |
| `aws/floor` | 2026-08-24 | #3042 | 2026-08-27 |
| `gcp/floor` | 2026-08-25 | #2743 | 2026-08-26 |

`contested` takes **no side**. Whether a later red is a flake or a regression needs someone to read the run, and guessing either way is worse than naming the contradiction. It claims only what is derivable — the two sources disagree, so the ✅ is not trustworthy right now.

**Two human acts clear it, and either one is fine:** close the issue if that run was a flake, or append a `FAIL` row for it if it was not. The next derivation picks the answer up.

### Blocked on a human

- #2698 — security(billing): runColonyTasks lets the caller set its own fan-out, behind one up-front budget hold
- #2697 — security(audit): queueAudit attaches a job to any projectId without authorizing it, and an AI tool supplies that id
- #2683 — fix(billing): a failed metering write leaks the AI budget hold it was meant to reconcile
- #2679 — security(promotions): protection rules are authorized on one project and written to another
- #2663 — fix(cli): `project get <name>` resolves to an arbitrary project when two share a name
- #2485 — prod: the console has not deployed since 2026-07-30 — a cross-app import in the pruned image build, masked by fail-fast behind an expired PostHog key
- #2482 — release: the console never learns about a new CLI version — the notification's credentials cannot mint from a tag
- #2465 — programme: two of the six MVP predicates assert something no script can check
- #2462 — infra(e2e): make the e2e-dev OIDC trust widening authoritative — four applies, currently hand-applied
- #2283 — probe(alibaba-cr): does an AUTO scan rule fire with no VPC endpoint? (#2265 shipped the wiring, not the proof)
- #2099 — e2e nightly: gcp RED (full-bar)
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
| `infra/template-parity-exclusions.yaml` | exclusions: 0 · baseline: 301 · uniform: 12 |

### Provenance

Every number above is derived from these, and from nothing else:

- `test/e2e/generated/programme.json`
- `demos/proofs/provisioning-e2e-log.md`
- `.github/workflows/e2e-nightly.yml`
- `scripts/e2e/resolve-dimension.sh`
- `apps/console/lib/cloud-providers/unsupported-kinds.ts`
- `demos/proofs/<cloud>/<stamp>/`
- `docs/testing/programme-snapshot.json`

Live board snapshot: taken **2026-08-27T19:16:22Z** — refreshed by `.github/workflows/programme.yml`, which opens a PR rather than pushing. Warns past 48h, fails past 7 days.

The timestamp is printed VERBATIM from the snapshot, never as an age. An age is computed from the current clock, so it would drift with no change to any input and make this diff-gated region stale an hour after every refresh — redding CI for everyone. The clock is only ever used to FAIL on a snapshot older than 7 days, which is a deliberate exception: a refresh that has silently stopped produces no other signal.

Ledger rows read: **47** · surviving claims: **21** (a `RETRACTED` row voids a claim rather than replacing it, so surviving < rows is expected).

_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._

<!-- END GENERATED: programme-rollup -->
