---
name: dev
description: How to run the Alethia app — the console, its backends, a runner, or the E2E/browser flows. Use whenever you need a RUNNING app rather than a passing test: starting the console, reproducing a bug in the browser, checking a UI change, wiring Stripe/OAuth, or when a command like `pnpm dev:up` is blocked. The Mac is not a runtime; environments run on the sandbox box via `pnpm env:*`.
license: AGPL-3.0-only
---

# Running Alethia

**The Mac is not a runtime.** It keeps the editor, git, and the cheap checks (`tsc`,
`lint`, `vitest`). Everything that *runs the product* — the console, Postgres, OpenFGA,
object storage, runners — lives on a Hetzner sandbox box, one environment per branch,
served over HTTPS.

This is not a preference. The laptop measured 92% disk and 86% swap with `go build`
failing on ENOSPC; `pnpm dev:up`, `pnpm dev:stack` and `pnpm compose:up` are blocked by
`.claude/hooks/guard-runtime.sh`.

## The loop

```bash
pnpm env:up          # this branch gets an env: database, storage, store, URL. Idempotent.
pnpm env:push        # after editing — rsync the working tree (uncommitted work included)
pnpm env:logs        # tail the console  ← SIGN-IN CODES ARE PRINTED HERE
pnpm env:open        # open it in a browser
pnpm env:down        # give the slot back when you're done with the branch
```

`env:up` prints the URL. Branch envs are `https://<slug>.dev.alethialabs.io`, where
`<slug>` is the branch with `feat/`/`fix/` stripped.

**There is no hot reload.** The sync is on command, so an edit on your Mac is invisible
to the box until `pnpm env:push`. If you are iterating tightly, run `pnpm env:push
--watch` in a second console (needs `brew install fswatch`).

## Signing in

No credential is copied to the box — every secret is minted there. That includes *not*
setting `ALETHIA_SES_REGION`, which makes `getEmailConfig()` return `ses: null` and
`sendEmail` **log** the message instead of sending it
(`packages/email/src/{config,send}.ts`).

So: request an email OTP, then read the six-digit code out of `pnpm env:logs`.

**Social sign-in and Stripe webhooks only work on `dev.alethialabs.io`**, the primary
env. OAuth redirect URIs cannot contain wildcards, so they are registered against that
one hostname. Branch envs are email-OTP only. Don't debug "broken Google sign-in" on a
branch env — it was never wired.

## Other things you may want

| Need | Command |
|---|---|
| `tsc` / `lint` / `vitest` for a worktree | `pnpm env:check` — worktrees are de-hydrated (no local `node_modules`) |
| A provisioning runner against your env | `pnpm env:runner` |
| A shell on the box | `pnpm env:ssh`, then `tmux attach -t alethia-<slug>` |
| Everything running, capacity, who holds what | `pnpm env:status` |
| A clean database | `pnpm env:up --fresh` — drops and recreates **only your** env's database |
| Local disk / Docker / worktree health | `pnpm dev:doctor` |

## Rules that will bite you

- **The box caps at 3 concurrent environments** (a memory budget: ~2 GB per `next dev`
  on 16 GB). The fourth is refused with a list of who holds the others — nothing is
  ever evicted automatically, because a silent swap kills someone else's run.
- **Never `docker compose down -v` or `pnpm db:reset`.** `docker-compose.yml` pins
  `name: alethia`, so those delete the volumes *every* window is using. Blocked.
- **Never run `docker compose` from an env's tree on the box.** Each env is a different
  checkout; a branch that touched the compose file would re-converge the shared
  containers under every other env. `scripts/box/env-shared.sh` owns the shared tier.
- **Never build fleet runner images on the box.** `pnpm env:runner` uses `MODE=native`
  deliberately — an image built for the wrong architecture is what churned ~100 fleet
  VMs in 8 hours.
- **The box is reaped when idle** (`pnpm env:reap` snapshots and *deletes* it — a
  stopped Hetzner server still bills). While it is down, the hostnames return
  Cloudflare error 1033. `pnpm env:box` restores it in 1–2 minutes with state intact.
- **Creating the box runs `tofu apply`, which is a human action** in this repo. `env:up`
  will point you at `pnpm env:box` rather than provisioning cloud resources for you.

## What still runs locally

Building, type-checking, linting, unit tests, git, and every read-only Docker command.
`pnpm db:up` (Postgres only, ~30 MB) is still allowed for local integration tests.

If you genuinely need a local runtime, `export ALETHIA_LOCAL_DEV=1` **before launching
`claude`** — an inline `VAR=1 pnpm dev:up` prefix cannot work, because the guard is a
PreToolUse hook spawned before the command runs.

## Reference

- `infra/sandbox/README.md` — the box, sizing, cost, and why it is x86 rather than ARM
- `scripts/env.sh` — the entry point; `scripts/box/*` runs on the box
- `CLAUDE.md` → *Running the app*
