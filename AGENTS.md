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
- Do not run `git add -A` for scoped issue work. Stage only files inside the issue's `scope:` globs.
- Do not run `docker compose up` directly. Use `pnpm compose:up`; it is lock-guarded for the shared
  `alethia` compose project.
- Do not generate migrations concurrently. Use the repo command (`pnpm -F console db:generate`),
  which is guarded by `scripts/db-generate.sh`, and respect any `mutex:migration` issue claim.
- Do not merge directly to `dev`, `staging`, or `main`. Open a PR into `dev`; for autonomous backend
  work, enqueue green PRs with `gh pr merge --auto --squash`.
- Do not add `Co-Authored-By` or other attribution lines to commits.

## Issue Board Flow

```sh
scripts/claim-work.sh --class backend
pnpm wt <printed-slug>
cd ../wt-<printed-slug>
# build only inside the issue scope; open PR with "Closes #<issue>"
gh pr merge --auto --squash # backend only, after checks are green
scripts/complete-work.sh <issue>
```

Use `scripts/claim-work.sh --heartbeat <issue>` during long work, and run `scripts/coordinate.sh`
to refresh blockers, reclaim stale leases, and inspect the board.

## Guard Coverage

Repository Git hooks in `.githooks/` protect humans and agents at commit/push time. Claude also has
PreToolUse hooks in `.claude/hooks/`; Codex should treat `AGENTS.md`, `CLAUDE.md`, and the Git hooks
as the source of truth unless Codex-specific tool hooks are added later.
