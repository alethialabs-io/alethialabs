# Alethia Codex harness

This project uses Codex with autonomous routine execution inside the trusted workspace. The
project sandbox permits workspace writes and network access for checks, GitHub, and sandbox
environment commands. The hooks in this directory adapt the existing `.claude/hooks/` policy to
Codex's lifecycle JSON contract.

## First run

1. Restart Codex from this worktree.
2. Run `/hooks` and trust the Alethia project hooks once.
3. Run `pnpm codex:doctor`.
4. Run `pnpm codex:self-test`.

Routine implementation may edit, verify, commit, push, and open a PR into `dev`. The hooks and
repository hooks still block shared-main commits, foreign worktree writes, local runtimes,
destructive resets, protected pushes/merges, and infrastructure apply/destroy operations.
