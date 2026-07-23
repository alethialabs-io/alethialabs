---
name: foundry
description: Run the continuous autonomous build loop over the coordination board — claim a backend unit, build it in its own worktree, open a non-draft PR into dev, and re-enter to claim the next one, self-pacing with ScheduleWakeup. Use when asked to "run the engine", "work the board", "keep building", or drive the foundry loop with no per-unit human prompt.
argument-hint: "(optional) how long / how many units to run before stopping"
disable-model-invocation: true
license: MIT
metadata:
  source: alethia (app-only — NOT yet in alethialabs-io/skills; upstream it there so every worktree syncs it)
  adapted-for: alethia
---

You are the **foundry**: a running instance that self-sustains the build loop over the coordination
board (`.claude/COORDINATION.md`) with **no per-unit human prompt**. You drive `scripts/engine.sh` —
a thin dispatcher over the existing `claim-work.sh` / `coordinate.sh` / `complete-work.sh` — and pace
yourself with **ScheduleWakeup** so one invocation carries the loop across many units.

Read `.claude/COORDINATION.md` first (the board contract) if you have not this session. Then run this
loop, **one unit at a time**:

## The loop (repeat until STOP)

1. **Claim** — `scripts/engine.sh claim`.
   - It runs `claim-work.sh --class backend` (backend only — see the UI rule below) and prints the
     claimed issue `#n`, its `scope:` globs, and a `pnpm wt <slug>` line.
   - **If it exits non-zero with code 3 ("No ready … unit")** → the board is drained. **STOP** (see
     Stopping). Do not retry-spin; if you want to wait for new work, schedule a distant wakeup instead.
   - Never hand-claim (assign/label an issue yourself) — that skips the atomic lock + cross-box verify.

2. **Set up the worktree** — `pnpm wt <slug>` then `cd ../wt-<slug>` (per CLAUDE.md's one-worktree-per-
   unit rule). Build **ONLY within the unit's `scope:` globs**. Never `git add -A` — stage explicitly.
   If you need a file outside your scope, it belongs to another unit; coordinate, don't grab it.

3. **Build + auto-heartbeat** — implement the unit. A build can outlast the lease TTL (`LEASE_TTL`,
   default 3600s), and a stale lease gets reclaimed out from under you. So at **each build checkpoint**
   (finishing a file, running tests, before a long compile) run:

   ```
   scripts/engine.sh heartbeat <n>
   ```

   This re-stamps the lease so coordinate.sh never reclaims your in-flight unit. Cheap — call it
   liberally on any long unit.

4. **Open a NON-DRAFT PR into `dev`** with `Closes #<n>` in the body (title per the unit).
   - **Backend = full-auto.** Do **NOT** run `gh pr merge`. Mergify auto-queues every non-draft,
     conflict-free `dev` PR and squash-merges it in order once required checks pass; the
     close-on-dev-merge Action then closes the issue. Your job ends at "green non-draft PR open."
   - Keep genuinely-unfinished work a **draft** (drafts are excluded from the queue). If Mergify
     reports a **conflict**, rebase onto `origin/dev` and push (it re-queues automatically).
   - **Never** merge to a protected branch, never `gh pr merge --admin`, never target `staging`/`main`.

5. **Complete** — once the PR has merged and the issue closed, run:

   ```
   scripts/engine.sh complete <n>
   ```

   It releases the claim and runs a `coordinate` pass so downstream `blocked-by: #n` units unblock and
   become claimable. (If you are pipelining, you can move to the next claim without waiting on the
   merge — but always `complete` the unit once it lands so the board reads clean.)

6. **Pace + re-enter** — use **ScheduleWakeup** to re-enter this loop and claim the next unit, rather
   than busy-looping in one turn. Pick an interval that fits: a short delay when you handed a PR to the
   queue and want to start the next unit; a longer one when you're waiting on a merge or CI. On wake,
   go to step 1.

## The UI rule (never auto-merge UI)

The engine's `claim` only ever requests `--class backend` — the autonomous path. **`class:ui` units
stay human-gated** (`.claude/COORDINATION.md` → "the two work classes"): a UI unit's deliverable is a
**data-model-grounded design spec** authored per the `alethia-design` skill for Claude Design, **not a
merged PR**. Never take a `class:ui` unit through this loop's enqueue path. If the board only has UI
work left, `claim` returns nothing (exit 3) → STOP and surface the `needs:design` units to the human
(`scripts/engine.sh status` lists them).

## Between units — keep the board healthy

Run `scripts/engine.sh coordinate` periodically (e.g. once per few units, or on a scheduled wakeup):
it reclaims dead instances' stale leases, recomputes `blocked` labels, and reports collisions +
possibly-shipped units. `scripts/engine.sh status` is the read-only version (no mutations) — use it to
eyeball the board any time.

## Stopping (hard rules)

STOP the loop — do not schedule another wakeup — when **any** of:

- `scripts/engine.sh claim` exits **3** (no ready backend unit — board drained).
- The **human says stop** (or your run budget / the optional argument's limit is reached).
- You hit a blocker you cannot safely resolve (e.g. a migration-mutex conflict, a scope you can't own,
  repeated CI failures you can't diagnose). Surface it, don't route around it.

The engine is a **scaffold you drive**, not a fire-and-forget process. It never merges to protected
branches and never runs applies — keep it that way. When you stop, leave a one-line board summary
(`scripts/engine.sh status`) so the next instance or the human picks up cleanly.

## Alethia notes

- This skill is **app-only** and not yet in the source-of-truth repo `alethialabs-io/skills` (see
  `.claude/skills/README.md`). **Upstream it there** so every worktree/instance syncs it via
  `scripts/sync-skills.sh`; until then it lives only in this repo.
- Multi-instance safety comes from the underlying scripts (atomic mkdir-lock, cross-box claim-and-
  verify, migration mutex) — the engine adds none of its own locking. Trust the board primitives;
  don't reimplement them.
- For handing an in-flight unit to another session, use the `handoff` skill (reference the issue +
  worktree/branch — don't re-explain the diff).
