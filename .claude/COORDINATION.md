# Instance coordination — the claimable board

Many AI instances (Claude, Codex, and humans) drive the north star in parallel. Isolation and integration are already
solved by the multi-instance rules in `CLAUDE.md` (one worktree per instance via `pnpm wt`; PR → `dev`;
**Mergify auto-queues + squash-merges every non-draft, conflict-free `dev` PR on green** — you run no
`gh pr merge` and never merge directly; lock-guarded
migrations). **This file is the missing third half: how work is
distributed** so N instances claim disjoint work without collision, respect dependencies, and never tangle
each other's files.

It is the runner job-model applied to instances: a **claimable job table** (GitHub Issues), an **atomic
claim** (mkdir-lock), a **lease + reclaim** for a dead instance's work (like #534 orphan-reclaim), a **mutex**
on shared state (migrations, like `db:generate`), and **serialize-per-state-object** (disjoint file lanes,
like #530). You already built and debugged this for provisioning — this reuses its lessons.

## The board (hybrid)

- **GitHub Issues = the live execution board.** One issue per claimable work unit. Labels:
  - `wave:W1`…`wave:W7` / `wave:hygiene` — which north-star wave (see `00-NORTH-STAR.md`).
  - `lane:schema` · `lane:server` · `lane:runner` · `lane:core` · `lane:canvas` · `lane:tests` · `lane:docs`.
  - `class:backend` or `class:ui` — the routing rule (below).
  - `claimed` — set when an instance holds it; carries a **lease comment**.
  - `blocked` — maintained by `coordinate.sh`: present while any `blocked-by` is still open.
  - `mutex:migration` — this unit generates a drizzle migration (serialized; see below).
  - `needs:design` / `needs:human` — a UI unit awaiting the human/Claude-Design pipeline.
- The issue **body** declares two machine-read lines:
  - `blocked-by: #12 #14` — units that must close first.
  - `scope: apps/console/lib/db/schema/** packages/core/types/**` — the files this unit owns (globs). No two
    open+claimable issues in a wave may share a scope glob — that is how the mega-commit tangle is prevented.
- **Management ledger = the plan.** `00-NORTH-STAR.md` holds the wave DAG; each wave gets a design doc in
  `management/spec/features/`. Board = execution state; ledger = design. An issue links its wave doc.

## The two work classes (the routing rule)

**`class:backend`** — server actions, runner, schema, core, tofu, tests, docs. **Fully autonomous:**
claim → `pnpm wt` → build → **open a non-draft PR into `dev`** → **Mergify lands it on green** (it auto-queues
every non-draft, conflict-free `dev` PR and squash-merges it in order, validating each on its own branch — you
run NO `gh pr merge`). The human is NOT in the loop.

**`class:ui`** — canvas, components, anything visual. **Human-in-the-loop.** A UI unit's deliverable is NOT a
merged PR — it is a **UI design spec grounded in the data model** the backend lanes define (the seams issue +
`project_*` schema), authored per the `alethia-design` skill and shaped for **Claude Design** ingestion. The
visual is then built and **the human gates the merge.** A `class:ui` issue lands `needs:design` and surfaces
to the human; it never enters the autonomous enqueue-on-green path. Because backend lanes define the data model
first, UI specs always have a stable model to consume (never pixels-before-schema). This operationalizes the
"UI work is a spec" rule.

## The protocol

Every instance, at kickoff, reads this file, then:

```
scripts/claim-work.sh --class backend      # atomically claim the next ready backend unit
cd ../wt-<slug>                             # the script prints the pnpm wt slug
# ... build; open a NON-DRAFT PR into dev with "Closes #<n>"; Mergify auto-queues + squash-merges on green (run NO gh pr merge) ...
scripts/complete-work.sh <n>               # REQUIRED: a dev squash-merge does NOT auto-close the issue (dev isn't the default branch) — this closes + de-claims it; coordinate opens downstream
scripts/claim-work.sh --class backend      # loop
```

- **Atomic claim** (`claim-work.sh`): acquires `/tmp/alethia-claim.lock` (atomic `mkdir`, stale-reclaim by
  pid — same primitive as `compose-up.sh`), picks the next issue that is `open`, not `claimed`, not `blocked`,
  in the requested class, honoring the migration mutex, then assigns `@me` + `claimed` + posts a lease comment,
  then releases the lock. The lock serializes the pick-and-assign critical section across all **same-box**
  instances.
- **Cross-box safety (claim-work.sh, two guards).** The mkdir-lock is a same-box mutex, and every instance
  authenticates as the **same GitHub user** (so the assignee can't distinguish them) — nothing stops two
  *different machines* from claiming one unit (this caused the #587 / #611 / #842 duplicate builds). Two guards
  close it:
  - **Pre-claim PR guard** — before assigning a candidate, skip it if an **open or merged** PR already closes
    it (`Closes #n`). Catches work in flight on another box, and the stale-open case (an issue whose PR merged
    but GitHub never auto-closed, e.g. #687 → merged #824).
  - **Claim-and-verify (earliest-lease-wins)** — after assigning + leasing, wait `ALETHIA_CLAIM_VERIFY_DELAY`
    (default 5s), re-read the issue's lease comments, and let the lease with the **earliest GitHub-server
    `createdAt`** win (tiebreak: lowest `instance`). Server timestamps are skew-free, so every contender
    computes the *same* winner: the first claimer keeps it, later claimers **cede** (post a `ceded:` comment and
    re-pick — they do NOT remove the shared `claimed` label/assignee, which the winner also set). `--self-test`
    exercises the winner logic against fixtures; set `ALETHIA_CLAIM_VERIFY_DELAY=0` to disable (same-box-only).
- **NEVER hand-claim a unit** (assigning `@me` / adding `claimed` by hand): it bypasses BOTH the lock and the
  claim-and-verify, which is exactly how the #842 dup happened. If `claim-work.sh` offers a stale or wrong unit
  (e.g. its work already merged, or it needs a maintainer decision), **fix the board so the script skips it** —
  `gh issue close <n>` the done one, or `gh issue edit <n> --remove-label class:backend` an un-actionable one —
  don't reach around the script to grab a different issue.
- **Lease + reclaim**: the lease comment carries `instance · pid · branch · UTC-timestamp`. Refresh it on each
  PR push (the worker) — or just let `coordinate.sh` reclaim a unit whose lease is older than `LEASE_TTL` and
  whose linked PR/branch shows no recent activity. Reclaim = clear assignee + `claimed`, comment "reclaimed".
- **Migration mutex**: only ONE open issue may hold `mutex:migration` claimed at a time. `claim-work.sh`
  refuses to claim a second. Never run `pnpm -F console db:generate` in two worktrees at once — the drizzle
  snapshot chain is un-mergeable (this is the board-level guard on top of `scripts/db-generate.sh`).
- **File-scope discipline**: only claim/build within your issue's `scope:` globs. Never `git add -A`; stage
  only your scope. If you need a file outside your scope, it belongs to another unit — coordinate, don't grab.

## The coordinator (hybrid — you-in-loop-for-UI)

`scripts/coordinate.sh` is the light shared brain any instance or the maintainer runs (on demand, or wrapped
in `/loop` for an always-on backend engine):

- **Reclaim** stale leases (dead instances).
- **Unblock**: recompute the `blocked` label from each issue's `blocked-by` (remove it once all blockers close).
- **Report** the board: per-wave open/claimed/blocked/done counts, who holds what and for how long, the ready
  (claimable) set, and any **collisions** to eyeball (two claimed issues sharing `mutex:migration` or an
  overlapping `scope:`).
- **Surface UI**: list `needs:design` units for the human.

Backend flows without you. UI surfaces to you. The coordinate pass is not an always-on single point of
failure — it is stateless over the board, so any instance can run it.

## Bootstrapping a wave

1. Author the wave design doc in `management/spec/features/` and grill it.
2. Create the labels (once): `scripts/coordinate.sh --init-labels` (or `gh label create …`).
3. Seed **interface-first**: one small `class:backend` "seams" issue (the shared types/schema/contract) with
   no `blocked-by`; then the fine lanes (`blocked-by:` the seams issue), each with a disjoint `scope:`.
4. Merge the seams issue fast → downstream unblocks → instances claim and go.
