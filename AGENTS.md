# Alethia Agent Instructions

This repo supports parallel AI and human work. Codex, Claude, and other coding agents must follow the
same source-isolation and board-claiming protocol.

## Start Here

- Read `CLAUDE.md` for the full repo operating contract. Despite the filename, its worktree,
  merge-queue, local-stack, migration, and verification rules apply to every agent.
- Read `.claude/COORDINATION.md` before taking issue-board work. The coordination board is shared;
  do not hand-pick or hand-claim issues.

## Non-Negotiables

- Do not do feature work in `app/`, the main checkout. Create a sibling worktree with
  `pnpm wt <name>`, then work in `../wt-<name>`.
- A worktree is **owned** while someone works in it. Creating, reusing, or writing into one takes a
  lease. Do not write into, remove, or push from a worktree another live instance holds — `pnpm
  wt:who` shows every holder (`live` / `stale` / `free`), `pnpm wt:release` hands yours back, and
  `pnpm wt:steal <name>` takes one whose holder is genuinely gone. Reading another instance's
  worktree is fine. This rule exists because an instance was handed a live tree ("already exists …
  Reusing it") and swept another's uncommitted work into its own commit.
- Do not run `git add -A` for scoped issue work. Stage only files inside the issue's `scope:` globs.
- Do not run `docker compose up` directly. Use `pnpm compose:up`; it is lock-guarded for the shared
  `alethia` compose project.
- Do not generate migrations concurrently. Use the repo command (`pnpm -F console db:generate`),
  which is guarded by `scripts/db-generate.sh`, and respect any `mutex:migration` issue claim.
- Do not merge directly to `dev`, `staging`, or `main`, and do not run `gh pr merge` at all. Open a
  **non-draft** PR into `dev`; Mergify auto-queues every non-draft, conflict-free `dev` PR and
  squash-merges it in order once the required checks pass. Keep WIP as a draft.
- Do not add `Co-Authored-By` or other attribution lines to commits.

## Issue Board Flow

```sh
scripts/claim-work.sh --class backend
pnpm wt <printed-slug>
cd ../wt-<printed-slug>
# build only inside the issue scope; open a NON-DRAFT PR into dev with "Closes #<issue>"
# Mergify queues + squash-merges it on green — run NO gh pr merge
scripts/complete-work.sh <issue> # REQUIRED: a dev squash-merge does not auto-close the issue
```

Use `scripts/claim-work.sh --heartbeat <issue>` during long work, and run `scripts/coordinate.sh`
to refresh blockers, reclaim stale leases, and inspect the board.

## Guard Coverage

Repository Git hooks in `.githooks/` protect humans and agents at commit/push time. Claude also has
PreToolUse hooks in `.claude/hooks/`; Codex should treat `AGENTS.md`, `CLAUDE.md`, and the Git hooks
as the source of truth unless Codex-specific tool hooks are added later.
