<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The MVP programme

**Read this first, every session.** It is the one file that answers _where is the programme, what is
proven, and what is next_ — so that nobody has to re-derive it by reading fifteen boards, and nobody
has to re-brief it after a context clear.

The programme is one sentence:

> Reach the public beta defined by the nine predicates B1–B9 in `docs/beta/README.md`, on every cloud
> the catalog offers, and prove each predicate from evidence a script reads.

The clouds are not a list kept in this file. They are the clouds `packages/core/catalog/catalog.json`
can provision and marks `available`, and decision D6 says what a `hidden` cloud keeps and how one
comes back. Predicate B1 holds that set to the one the beta is defined on.

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

## §0 · What "beta reached" means

Nine predicates, **B1–B9**, defined in `docs/beta/README.md` (REL-S1, #6773), with the evidence-record
format in `docs/beta/evidence-schema.json`. They replace the six MVP predicates this section used to
hold and the management roadmap's MVP definition. They are written to be **checked by a script, not
read as prose**: `scripts/programme-rollup.mjs` evaluates each one and renders the result first under
the marker. This file does not restate them, because a copy here would go stale and nothing would
report it.

The old predicates survive as inputs, not as a second definition: the proof grid (old 2) and the CLI
row (old 4) feed B3 and B4, and the orphan reaper (old 6) feeds B9. Capability parity (old 1),
`DeferredInProduct` (old 3) and the scenario set difference (old 5) are still rendered and still held
by the ratchets below.

Three rules decide how the rollup evaluates them, and each is stated in the definition:

- **Nothing is assumed from silence.** A missing record, an instrument not built yet, and a fact the
  tree and the snapshot do not carry all render `not measured`, and `not measured` is not met.
- **No clock.** Every age limit is measured back from the snapshot's `derived_at`, printed verbatim.
- **A record is one observation.** It is never edited to change its verdict; the newest by `date`
  decides.

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
3. **The floor, on every scored cloud.** Nothing above the floor is measurable until a cloud
   provisions and converges at all.
4. **Parity ratchets** — fully parallel with 3 and 5, because per-cloud template trees are disjoint
   and touch no credential and no migration. This is where N-way agent parallelism actually lives.
5. **The full bar, per cloud, by dispatch** — blocked on a durable ledger and on that cloud's floor.
6. **Scenario layers, then the CLI bar** — one gate per dispatch, then unset it.
7. **The beta predicates B1–B9.** The CLI-first order that ended in "then UI" is withdrawn by the
   2027-01-31 beta spec; decision D5's qualification of the UI wave is kept as history.

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
  **Amended 2026-09-23 (#4942): that ruleset was never created.** No ruleset (`dev`, `staging`,
  `main`) sets `require_code_owner_review` to true (`main` sets false explicitly; `dev` and `staging`
  take the provider default) and all require 0 approvals, and CODEOWNERS is advisory on
  all three branches, not only off `main`. The maintainer ruled to correct the docs rather than add
  the control, so a PR editing `e2e-nightly.yml` can land on `dev` with no human review. What does
  bound the widening is listed at the `environment:` line of `.github/workflows/e2e-nightly.yml`.

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

- **D5 · 2026-09-01 · Console UI conformance runs as its own wave, in parallel — the phase ordering
  above is not amended, it is qualified.** §1 puts UI last, and the one-sentence intent says "then,
  and only then, UI". That ordering is about *spend and proof*: a UI phase that competes for the
  five-cloud dispatch budget, the single branch-env slot, or the maintainer's review attention would
  push the proof cells out, and that is still refused.

  `wave:console-ui` (epic #3613) competes for **no cloud dispatch budget** — that is the resource the
  ordering exists to protect, and the one this wave genuinely does not touch. Its recurring gate runs
  in CI rather than against a real cloud, and its instrument half is pure-Node static analysis. Note
  that gate is not free to wire: the config is `apps/console/playwright.config.ts` (there is no root
  copy), Postgres comes from a per-job `services:` block in `ci.yml` rather than from the config, and
  `assertNoDeadZone()` fails a run whose project has no CI job — so the wave needs a NEW ci.yml job,
  which is #3632's scope. "Already boots one" understated that.

  That is the whole of the argument; the two stronger claims an earlier draft made are not true and
  are recorded here as refused rather than quietly dropped:

  - **Its scopes are NOT disjoint from the rest of the tree.** They are mostly `apps/console/**`, but
    #3614 owns a route-manifest module in the shared `scripts` tree, #3617 owns the sandbox env
    scripts, and #3632 owns the CI workflow — and those last two are exactly the shared files a
    disjointness argument would need to exclude. `ci.yml` was edited by e2e/infra/coverage work three
    times last month (#3586, #3457, #3298) and `scripts/env.sh` by the isolation-ladder work (#3449).
    Collision is possible and the mitigation is the ordinary one — `scripts/claim-work.sh` refuses an
    overlapping claim — not a property of this wave.
  - **It DOES compete for the maintainer's review attention**, the third protected resource. Four of
    its units (#3628–#3631) carry `class:ui` + `needs:design`, which `.claude/COORDINATION.md`
    defines as human-in-the-loop with a human-gated merge. That is a real cost and it is the one to
    weigh when deciding whether to run this wave now.

  On the branch-env slot: #3633 needs it; #3632 does not (its own body says it costs CI minutes, not
  a sandbox box), so the `#3617 → #3632 → #3633` chain serialises correctly but its middle term is
  ordering, not contention. Those edges live on the board and are hand-maintained — read them there
  rather than trusting this paragraph, which is exactly the "this file ranks; it never claims"
  rule from the preamble.

  The decision is recorded here because the alternative is worse than the reordering: a ledger that
  reads "then, and only then, UI" while a UI wave is being built is a ledger disagreeing with the
  tree, which §1's own first phase exists to prevent. The ordering claim that remains true, and is
  the one worth keeping: **no cell of the proof grid may be deferred for it.**

- **D6 · 2026-11-16 · The exit criteria and the nightly are scored on the clouds the catalog offers,
  and Alibaba Cloud is hidden.** The scored set is every cloud
  `packages/core/catalog/catalog.json` can provision and marks `available`. Nothing downstream types
  it: `test/e2e` derives `DemoClouds` from the catalog, the mirror carries the result, the rollup
  renders it, and `scripts/check-e2e-spend-guard.mjs` holds the nightly's scheduled matrix to it in
  both directions.

  A `hidden` cloud is **retired, not deleted**. Its templates, tests and parity-board column stay, so
  its code keeps compiling and keeps being compared. Its proof-ledger rows stay, because the ledger
  is append-only; the rollup reads them and scores none. It stays a dispatch option of
  `.github/workflows/e2e-nightly.yml` with its spend control in force, and no timer runs it.
  Where D3, D4 and D5 say "five", they describe the programme on the day they were written.

  **To bring a cloud back:** mark it `available` in the catalog and run `pnpm gen:catalog`; regenerate
  the mirror (`TestProgrammeExport`) and this file (`pnpm gen:programme`); add it to the scheduled
  matrix literal and drop its override branch — the spend guard fails until the workflow and the
  catalog agree. Those steps are small. Meeting its proof cells again is the real cost, and for
  Alibaba Cloud that includes the prepaid registry purchase #2333 describes, which is a spend
  decision and therefore the maintainer's.

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

## §5 · The CLI programme — epic #3612

The CLI half of predicate B3 asks for a `cli-demo` proof row per cloud (it was MVP predicate #4). Reaching it is not one unit of work, so it
is decomposed as a programme, and **#3612** is the umbrella: the census it starts from, the rulings
the maintainer has made, the wave ordering, and the resume protocol.

Two things sit under that predicate, and only the first is obvious:

- **The CLI cannot be driven comfortably.** The bar asks whether `alethia <cmd> --help` exits 0,
  which the enterprise-demo tutorial satisfies while asking a reader to hand-assemble a four-field
  colon tuple three times and copy four opaque IDs between commands. So a `cli_ux` ratchet **will
  join** `cli_gap` — it is not declared yet, and §0's ceiling table is the place it becomes real,
  in the wave that implements it. Its intended numbers: copied placeholders in the golden-path
  docs, commands with no interactive path, entries in the CLI surface allowlist, and `Mirrors the
  Go X` claims with no mechanism behind them. Each may only decrease, and each must fail loudly at
  a zero census.
- **The CLI and the console are two implementations of one product.** A census of pure-logic pairs
  found rules written twice on both sides, several of them disagreeing — including both ends of a
  fail-closed gate and a path-traversal grammar looser than the shared one beside it. The tally
  lives on #3612, where closing a lane updates it; a number typed here would be stale the first
  time a wave lands and nothing would regenerate it.

Sharing is decided by what the thing *is*, not by which language reached it first. Data — enums,
vocabulary, regexes, limits, tokens — is codegen'd TS to Go and diff-gated. An algorithm gets a
generated conformance table both sides are tested against, because what must agree is the output.
A struct crossing the wire gets a fixture plus a strict decode in both directions.

**Direction follows authority.** The console owns formatting, so TypeScript generates the formatter
table; Go owns the apply gate, so Go generates the compat fixture. And the CLI's own validation is
a provable subset: it may only ever reject what the server would certainly reject, so drift can
make it too permissive — which the server catches — but never too strict.

Work is claimed from the board, never hand-picked: `scripts/coordinate.sh --report`, then
`scripts/claim-work.sh --class backend`.

<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->

## Beta predicates — B1 to B9

**1 of 9 beta predicates are met.** 6 not met · 2 not measured. Evaluated on this tree at the snapshot instant **2026-11-23T20:40:05Z**, over the 4 scored clouds: `aws`, `gcp`, `azure`, `hetzner`.

The predicates are defined in `docs/beta/README.md`; this section only evaluates them. `not measured` is not met: it means the instrument does not exist yet, or reads something the tree and the snapshot do not carry. Evidence records read: **0**.

| # | predicate | state |
|---|---|:---:|
| B1 | Exactly four clouds are offered | ✅ met |
| B2 | Golden path observed on production | ❌ not met |
| B3 | Same path from the CLI and through an outside agent | ❌ not met |
| B4 | A full-bar real-apply proof | ❌ not met |
| B5 | Paid plans are open, with live evidence | ❌ not met |
| B6 | Legal set published at sealed versions, including beta terms | ? not measured |
| B7 | Operations: backup, restore drill, public hosts | ❌ not met |
| B8 | Editions meet their own predicates | ❌ not met |
| B9 | Nothing left standing; nightly green | ? not measured |

| cloud | B2 | B3 | B4 | B9 |
|---|:---:|:---:|:---:|:---:|
| **aws** | ❌ not met | ❌ not met | ❌ not met | ? not measured |
| **gcp** | ❌ not met | ❌ not met | ❌ not met | ? not measured |
| **azure** | ❌ not met | ❌ not met | ❌ not met | ? not measured |
| **hetzner** | ❌ not met | ❌ not met | ❌ not met | ? not measured |

<details><summary>Why, per predicate</summary>

- **B1** ✅ met
  - offered set: ✅ met — Go (`Catalog.OfferedProviders`, via the mirror) and TypeScript (`AVAILABLE_CLOUDS`) both offer exactly {aws, azure, gcp, hetzner}
- **B2** ❌ not met
  - aws: ❌ not met — no B2 record
  - gcp: ❌ not met — no B2 record
  - azure: ❌ not met — no B2 record
  - hetzner: ❌ not met — no B2 record
- **B3** ❌ not met
  - aws CLI: ✅ met — `demos/proofs/aws/20260930T061330Z`
  - aws agent: ❌ not met — no agent-path record
  - gcp CLI: ✅ met — `demos/proofs/gcp/20260930T065516Z`
  - gcp agent: ❌ not met — no agent-path record
  - azure CLI: ✅ met — `demos/proofs/azure/20260930T095658Z`
  - azure agent: ❌ not met — no agent-path record
  - hetzner CLI: ✅ met — `demos/proofs/hetzner/20260930T011519Z`
  - hetzner agent: ❌ not met — no agent-path record
- **B4** ❌ not met
  - aws: ❌ not met — no successful bundle with `dimension: full`
  - gcp: ❌ not met — no successful bundle with `dimension: full`
  - azure: ❌ not met — no successful bundle with `dimension: full`
  - hetzner: ❌ not met — no successful bundle with `dimension: full`
- **B5** ❌ not met
  - paid state: ❌ not met — `PAID_MARKETS` is empty, so `paidLaunchState()` is not `open` (announced for: no date); decision M15 counts `announced` as not met
  - live evidence: ❌ not met — no B5 live-billing record
- **B6** ? not measured
  - sealed register: ✅ met — `terms` is sealed at 2026-08-24; the hashes themselves are held by `pnpm check:legal-hashes` and `pnpm check:legal-set` in CI
  - beta terms: ? not measured — nothing in the register records which `terms` version carries the beta and no-SLA wording (LEG-L2 writes it)
- **B7** ❌ not met
  - off-box backup: ✅ met — newest complete copy `20261123T144753Z` finished 2026-11-23T14:47:59Z, 5.8 h before 2026-11-23T20:40:05Z (backup-status.yml run 45239283153 at 2026-11-23T19:12:00Z)
  - restore drill: ❌ not met — no restore-drill record
  - public hosts: ? not measured — the post-deploy smoke result is not in the snapshot, and the installer and status hosts are not in the smoke yet (REL-L8)
- **B8** ❌ not met
  - hosted: ❌ not met — no B8 record
  - enterprise: ❌ not met — no B8 record
  - self-hosted: ❌ not met — no B8 record
- **B9** ? not measured
  - aws reaper: ✅ met — run 45246723457 at 2026-11-23T19:39:36Z reclaimed 1 orphan run(s) / 1 resource(s), then verified clean
  - gcp reaper: ✅ met — run 45246723457 at 2026-11-23T19:39:36Z found no orphan runs and verified clean
  - azure reaper: ✅ met — run 45246723457 at 2026-11-23T19:39:36Z found no orphan runs and verified clean
  - hetzner reaper: ? not measured — run 45246723457 at 2026-11-23T19:39:36Z found 1 unattributable resource(s)
  - nightly 6 of 7: ? not measured — the snapshot does not record the scheduled nightly's per-cloud verdicts, so 6 green of the last 7 cannot be counted

</details>

## Where the programme actually is

**29 of 29 proof cells are proven.** 0 failing · 0 contested (the ledger and the board disagree) · 0 stale (cause fixed, needs a re-run) · 0 blocked · 0 never run.

A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.

### Proof grid — cloud × dimension

| cloud | floor | all kinds | 18 add-ons | GitOps repos | BYO-IaC | day-2 | Starter templates | CLI-driven |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **aws** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **gcp** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **azure** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **hetzner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Legend: ✅ proven · ❌ failing · ⛔ blocked · · never-run · ♻️ stale · ⚠️ contested · — ceiling · 🔶 deferred · 💰 cost

**Not scored:** `alibaba`. The catalog (`packages/core/catalog/catalog.json`) marks a cloud listed here `hidden`, which takes it out of the exit criteria: it has no row above and no cell in any count below. Ledger rows naming one: 2 · demo steps scoped only to one: 1 — read and checked, never counted. Marking the cloud `available` again and regenerating puts its row back.

<details><summary>Every cell that has any evidence at all</summary>

- `aws/floor` **proven** — ledger 2026-09-30, bundle `demos/proofs/aws/20260930T194843Z`
- `aws/maxconfig` **proven** — ledger 2026-08-26, bundle `demos/proofs/aws/20260826T114712Z`
- `aws/addons` **proven** — ledger 2026-08-30, bundle `demos/proofs/aws/20260830T100243Z`
- `aws/gitops` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T142417Z`
- `aws/byo-iac` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T155743Z`
- `aws/day2` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T190408Z`
- `aws/templates` **ceiling** — Starter templates runs on hetzner only — proven once, as cheaply as possible, by #4113's decision — the tutorial does not change per cloud
- `aws/cli-demo` **proven** — ledger 2026-09-30, bundle `demos/proofs/aws/20260930T061330Z`
- `gcp/floor` **proven** — ledger 2026-09-30, bundle `demos/proofs/gcp/20260930T190822Z`
- `gcp/maxconfig` **proven** — ledger 2026-08-28, bundle `demos/proofs/gcp/20260828T124233Z`
- `gcp/addons` **proven** — ledger 2026-08-29, bundle `demos/proofs/gcp/20260829T093816Z` (⚠️ argocd counts unmeasured: pre-#3281 binary (A0.6's convergence loop wrote no summary); the assertion DID run and pass — run 33243600150 logs `all 20 asserted ArgoCD Applications are Healthy+Synced (1 withheld)`)
- `gcp/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/gcp/20260825T200519Z`
- `gcp/byo-iac` **proven** — ledger 2026-08-28, bundle `demos/proofs/gcp/20260828T110456Z`
- `gcp/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/gcp/20260825T210602Z`
- `gcp/templates` **ceiling** — Starter templates runs on hetzner only — proven once, as cheaply as possible, by #4113's decision — the tutorial does not change per cloud
- `gcp/cli-demo` **proven** — ledger 2026-09-30, bundle `demos/proofs/gcp/20260930T065516Z`
- `azure/floor` **proven** — ledger 2026-09-29, bundle `demos/proofs/azure/20260929T103904Z`
- `azure/maxconfig` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T211849Z`
- `azure/addons` **proven** — ledger 2026-08-30, bundle `demos/proofs/azure/20260830T005214Z`
- `azure/gitops` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T210320Z`
- `azure/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T204358Z`
- `azure/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T235236Z`
- `azure/templates` **ceiling** — Starter templates runs on hetzner only — proven once, as cheaply as possible, by #4113's decision — the tutorial does not change per cloud
- `azure/cli-demo` **proven** — ledger 2026-09-30, bundle `demos/proofs/azure/20260930T095658Z`
- `hetzner/floor` **proven** — ledger 2026-09-30, bundle `demos/proofs/hetzner/20260930T124805Z`
- `hetzner/maxconfig` **proven** — ledger 2026-08-29, bundle `demos/proofs/hetzner/20260829T105705Z`
- `hetzner/addons` **proven** — ledger 2026-08-29, bundle `demos/proofs/hetzner/20260829T085104Z`
- `hetzner/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/2026-08-25T175213Z`
- `hetzner/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/hetzner/20260827T210204Z`
- `hetzner/day2` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/20260825T192100Z`
- `hetzner/templates` **proven** — ledger 2026-10-01, bundle `demos/proofs/hetzner/20261001T200301Z`
- `hetzner/cli-demo` **proven** — ledger 2026-09-30, bundle `demos/proofs/hetzner/20260930T011519Z`

</details>

### The mechanical next

Nothing is actionable from the tree — every cell is proven, a ceiling, or blocked on a human.

### Capability surface

**Proof grid (11 provisionable kinds × 4 clouds = 44 cells):** 37 carried by tofu · 7 carried in-cluster · 0 cloud ceilings · **0 deferred (our debt)** · 0 excluded by cost.

**Parity grid (19 canvas NodeKinds × 4 clouds):** every cloud backs every kind.

### Driven from the CLI

**28 steps CLI-driven · 0 CLI gaps (our debt) · 3 cloud ceilings · 1 console by design.**

The CLI debt is **zero** — every remaining blocker is a thing the cloud offers no API for, not a thing Alethia has not built. That distinction is the one worth carrying into a demo.

⚠️ Reachability only. The bar asserts the command surface resolves; it does **not** provision, and its real-binary half runs only when `E2E_CLI_DEMO` is set.

| step | verdict | clouds | issue |
|---|---|---|---|
| `hetzner-s3-keys` | cloud_manual | hetzner | #2332 |
| `dns-delegation` | cloud_manual | all | #1773 |
| `gcp-budget-publisher` | cloud_manual | gcp | #1871 |

### Gate reality

Whether a dimension can run at all. A gate the workflow never mentions cannot be turned on by setting a variable.

**Which clouds can provision at all.** A leg whose gate is unwired green-skips every night.

| cloud | gate | state | evidence |
|---|---|:---:|---|
| **aws** | `E2E_AWS_ROLE_ARN` | ✅ wired | a leg reached the gate — run 45175308576 |
| **gcp** | `E2E_GCP_WIF_PROVIDER` | ✅ wired | a leg reached the gate — run 45175308576 |
| **azure** | `E2E_AZURE_CLIENT_ID` | ✅ wired | a leg reached the gate — run 45175308576 |
| **hetzner** | `HCLOUD_TOKEN` | ✅ wired | a leg reached the gate — run 45175308576 |

**Which dimensions can run.** A gate the nightly never mentions has no vehicle — setting a variable would not turn it on.

| dimension | gate | state | what it proves |
|---|---|:---:|---|
| floor | `(the cloud gate alone)` | n/a | real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set |
| all kinds | `ALETHIA_E2E_MAX_CONFIG` | ✅ by dimension: `ALETHIA_E2E_MAX_CONFIG` | every kind this cloud offers lands in tofu state (or converges as its named Application) |
| 18 add-ons | `ALETHIA_E2E_ALL_ADDONS` | ✅ by dimension: `ALETHIA_E2E_ALL_ADDONS` | all 18 marketplace add-ons Healthy+Synced |
| GitOps repos | `E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN` | ? unknown: `E2E_ARGO_APPS_REPO`<br>? unknown: `E2E_GIT_TOKEN` | a customer apps-destination repo and a BYO Helm chart converge, and each manages at least one real resource |
| BYO-IaC | `ALETHIA_E2E_BYO_IAC` | ✅ by dimension: `ALETHIA_E2E_BYO_IAC` | a customer OpenTofu root module is refused when unsafe, applied through the state proxy, drifts, heals and destroys — with state cleared |
| day-2 | `ALETHIA_E2E_SOAK (dimension) / E2E_DAY2_ACCESS` | ✅ by dimension: `ALETHIA_E2E_SOAK`<br>? unknown: `E2E_DAY2_ACCESS` | a real access path beyond the soak — kubeconfig / ArgoCD surface |
| Starter templates | `ALETHIA_E2E_TEMPLATES` | ✅ by dimension: `ALETHIA_E2E_TEMPLATES` | alethia-starter-apps, -chart and -ai each converge at their template commit through the documented path, on one cluster |
| CLI-driven | `ALETHIA_E2E_CLI_DEMO_PROVISION` | ✅ by dimension: `ALETHIA_E2E_CLI_DEMO_PROVISION` | a floor-shaped cluster provisioned through the real `alethia` binary rather than a seeded job row — the ACTOR, not the surface area |

⚠️ **The gate inventory is stale.** It was observed **2026-09-08T16:35:27Z**, more than 7 days before this snapshot was derived, so every **declared** gate above reads `unknown` rather than asserting a variable that may since have been deleted. An **observed** gate — a leg that actually got past it — still wins in both directions. The nightly's token cannot list repo variables or secrets at all, so the inventory only refreshes on a run carrying a PAT.

### Open REDs

No cell is failing or blocked.

### Orphan reaper — nothing standing

**3 of 4 clouds are verified clean.** A real reclaim result stays current for 48 hours.

A run that reclaimed an orphan may still finish clean; the incident counts remain visible. Dry runs, skipped gates, failed or missing logs, unverifiable checks and unattributable resources never count as clean.

| cloud | state | durable evidence |
|---|:---:|---|
| **aws** | ✅ clean | run 45246723457 at 2026-11-23T19:39:36Z reclaimed 1 orphan run(s) / 1 resource(s), then verified clean |
| **gcp** | ✅ clean | run 45246723457 at 2026-11-23T19:39:36Z found no orphan runs and verified clean |
| **azure** | ✅ clean | run 45246723457 at 2026-11-23T19:39:36Z found no orphan runs and verified clean |
| **hetzner** | ? indeterminate | run 45246723457 at 2026-11-23T19:39:36Z found 1 unattributable resource(s) |

### Blocked on a human

- #7351 — Maintainer legal review before consumer cells open: withdrawal email, consumer-rights page re-seal, BG consumers
- #7151 — infra/cp-hetzner: import the hand-made get.alethialabs.io record before the next apply
- #7148 — Public status page at status.alethialabs.io (Cloudflare Worker, like tovr.eu/status)
- #7030 — e2e nightly: 1 of 5 clouds are not enabled
- #7006 — CON-SM5c Lift the drafts list poll in the Elench drafts store
- #7005 — CON-SM5b Lift the being-answered poll in the Elench conversation
- #7004 — CON-SM5a Lift the settling plan-state poll in paid setup
- #6946 — EDN-H12 Nightly release-install run
- #6945 — EDN-H11 Decoupled per-cloud control-plane stacks
- #6944 — EDN-H10 Tested one-click templates
- #6943 — EDN-H9 Helm at parity with the compose install
- #6927 — CON-L14 Delete blockers: blocker list and audited release on account, organization, project, environment and cloud account
- #6898 — EDN-E9 Second factor and session policy
- #6897 — EDN-E8 Audit-log streaming
- #6896 — EDN-E7 SCIM provisioning
- #6895 — EDN-E6 IdP group-to-role mapping
- #6891 — EDN-S3 seams: the editions wave's one migration
- #6868 — AGT-L13 Registry and directory submissions
- #6803 — EDN-H0b Self-host configuration: required values, template placeholders, start-up check, rotation that runs on the box
- #6082 — e2e nightly: aws RED (keyless-db)
- #5235 — test(fabric): prove the enterprise demo on azure — blocked on the e2e subscription's 10-vCPU regional quota
- #4923 — epic(ownership): ALETHIA LABS EDPK takes possession — chain of title, the notices that disagree, the ee/ repository boundary, and public-repo licensing
- #4903 — infra(e2e): all three e2e IAM stacks have NO remote state — one laptop holds the only copy, and their declared backends do not exist
- #4374 — infra(cp-hetzner): adopt the live Cloudflare email routing — import the 11 resources and set the inputs in one change
- #4287 — maintainer(release-gate): the first /console-prod-qa run on production, and its report PR
- #3754 — fix(authz): members stuck ungranted by the toOrgRole gap are not backfilled — and a naive backfill would restore revoked access
- #2384 — e2e nightly: alibaba RED (full-bar)
- #2283 — probe(alibaba-cr): does an AUTO scan rule fire with no VPC endpoint? (#2265 shipped the wiring, not the proof)
- #1513 — feat(keyless): GA — default-on rollout and delete ALETHIA_KEYLESS_DB_AUTH_ENABLED
- #1450 — test(e2e): azure-mysql keyless real-apply on Azure (main-gated)
- #1268 — test(e2e): cross-account keyless cloud-SM in-cluster read — AWS/GCP/Azure/Alibaba (main-gated)

### Debt ratchets

| board | recorded debt |
|---|---|
| `infra/offer-exclusions.yaml` | exclusions: 26 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/config-carriage-exclusions.yaml` | exclusions: 32 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/template-parity-exclusions.yaml` | exclusions: 0 · baseline: 310 · uniform: 22 |
| `apps/console/e2e/gate-baseline.json` | failed: 0 · fixme: 0 · skip: 0 |

### Provenance

Every number above is derived from these, and from nothing else:

- `test/e2e/generated/programme.json`
- `demos/proofs/provisioning-e2e-log.md`
- `.github/workflows/e2e-nightly.yml`
- `scripts/e2e/resolve-dimension.sh`
- `apps/console/lib/cloud-providers/unsupported-kinds.ts`
- `demos/proofs/<cloud>/<stamp>/`
- `docs/testing/programme-snapshot.json`
- `docs/beta/evidence-schema.json`
- `packages/cloud-catalog/src/generated.ts`
- `packages/legal/src/paid-markets.ts`
- `packages/legal/src/launch.ts`
- `docs/legal/legal-set.json`
- `apps/console/docs/qa/prod-runs/`
- `docs/beta/evidence/<record kind>/`

Live board snapshot: taken **2026-11-23T20:40:05Z** — refreshed by `.github/workflows/programme.yml`, which opens a PR rather than pushing. Warns past 48h, fails past 7 days.

The timestamp is printed VERBATIM from the snapshot, never as an age. An age is computed from the current clock, so it would drift with no change to any input and make this diff-gated region stale an hour after every refresh — redding CI for everyone. The clock is only ever used to FAIL on a snapshot older than 7 days, which is a deliberate exception: a refresh that has silently stopped produces no other signal.

Gate inventory observed: **2026-09-08T16:35:27Z** — carried forward on every refresh whose token cannot list repo variables or secrets. Past 7 days behind the snapshot it stops being a measurement of today, and every declared gate degrades to `unknown`.

Ledger rows read: **79** · surviving claims: **32** (a `RETRACTED` row voids a claim rather than replacing it, so surviving < rows is expected).

_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._

<!-- END GENERATED: programme-rollup -->
