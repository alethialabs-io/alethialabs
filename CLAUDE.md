# Alethia — the operating contract

This file is what every instance reads before it acts. It holds **only** what you must know
*before* touching anything; everything else is one link away in the routing table at the end.

Keep it that way. It is verified by `pnpm check:docs-contract` (CI, `Authz / open-core guards`):
every path and `pnpm` script named here must exist, and no doc may recommend a command the
runtime guard blocks. It grew to 477 lines once and accumulated ~25 wrong statements — wrong
instructions here cost a wrong *action*, not just confusion.

Do not include any Co-Authored-By or attribution lines in commit messages.

---

## 1. Non-negotiables

- **Never commit or rebase in the main checkout (`app/`).** It is pinned to `dev` and shared by
  every session. One `git add -A` there once swept three features into one commit; a rebase is
  worse, because it moves the branch every other live session resolves against.
- **Never work in a worktree another live instance holds.** Check with `pnpm wt:who`.
- **Never target `staging` or `main` with a PR**, and never push to them. Feature work goes to
  `dev`; the maintainer promotes `dev → staging → main`.
- **Never run `tofu apply`, `terraform apply`, or a destructive `plan -destroy` on your own
  initiative.** The one exception is a specific named operation the maintainer has instructed,
  under a plan they have reviewed.
- **Never run the app on this Mac.** See §3.
- **Never generate a migration on a stale branch, or in two worktrees at once.** See §5.
- **Escape hatches are the maintainer's, not yours**: `--no-verify`,
  `ALETHIA_ALLOW_MAIN_COMMIT`, `ALETHIA_ALLOW_FOREIGN_WT`, `ALETHIA_LOCAL_DEV`.

## 2. One worktree per instance (enforced)

`pnpm wt <name>` creates `../wt-<name>` on `feat/<name>` off `dev`. Commit there, push, open a
PR into `dev`. `pnpm wt:ls` lists them · `pnpm wt:who` shows holders · `pnpm wt:rm <name>` ·
`pnpm wt:prune` sweeps landed ones (`--dry-run` previews) · `pnpm wt:release` · `pnpm wt:steal <name>`.
`pnpm branch:prune` does the same for the *branches* they leave behind (also `--dry-run`); plain
`git branch -d` cannot, because it asks an ancestry question that a squash merge always answers "no".

A worktree is **owned** while you work in it. Creating, reusing, or writing into one takes a
lease (`scripts/lib/wt-lease.sh`) keyed on your Claude process. Another instance then cannot
reuse, remove, edit, or commit from it — it is told who holds it. Reads stay allowed
(`git -C ../wt-other log`). Leases release automatically when the instance exits.

*Why:* on 2026-07-26 a second instance was handed a live worktree ("already exists … Reusing
it") and committed the first instance's **uncommitted** work under its own message (#1247).

Worktrees are **de-hydrated** — no local `node_modules`. Run their checks with `pnpm env:check`.

## 3. Running the app — the Mac is not a runtime

Everything that *runs* the product runs on the sandbox box, one environment per branch:

```
pnpm env:up      # this branch gets a database, storage, an OpenFGA store, a URL
pnpm env:push    # after editing — rsync the working tree  (--watch to automate)
pnpm env:logs    # tail the console  ← sign-in codes are printed here
pnpm env:status  # every env, who holds it, capacity
pnpm env:down    # RELEASE the slot when you're finished with the branch
```

The box is **shared** with every other instance and the maintainer: 2 environments (a
measured memory ceiling — an env needs 5–7 GB), and `dev` permanently holds one as the
integration env, leaving **one branch slot**. Take it only when you need a *running* app
— build, type-check, lint and unit tests do not need one — and release it when you are
done. Nothing is reclaimed automatically. If the box is down, **ask the maintainer**;
restoring it runs `tofu apply`, which agents are refused.

The box bills by the hour it **exists**, running or idle — deleting it is the only thing
that stops the meter, so a box left up costs €69.49/mo against €0.72 reaped. Run
`pnpm env:reap --now` when you finish; `pnpm env:timer` makes that automatic after 90
idle minutes.

The local dev servers and the destructive resets are **blocked** by
`.claude/hooks/guard-runtime.sh`. Measured reason: the laptop sat at 92% disk and 86% swap with
`go build` failing on ENOSPC, and the containers were never the cost — `next dev` was.

Read **`.claude/skills/dev/SKILL.md`** before running anything. Still local: build,
type-check, lint, unit tests, git, read-only Docker.

## 4. Landing work

Open a **non-draft PR into `dev`**. Mergify (`.mergify.yml`) auto-queues every non-draft,
conflict-free dev PR **with no unresolved review threads**, and squash-merges it once the
**required checks** pass, validating each PR on its own branch — so you never merge against a
`dev` that moved under you. Keep WIP as a draft. On a conflict, rebase onto `origin/dev` and push;
it re-queues itself.

**An unresolved review finding keeps a PR out of the queue, and RESOLVING IS A SEPARATE STEP FROM
FIXING.** A review is not a required check, so before #3498 the review and the merge raced by
construction and the review kept losing — five PRs squash-merged with their findings unaddressed,
one by four minutes. `#review-threads-unresolved = 0` closes that. Two consequences you will
otherwise hit:

- **Pushing the fix does not clear the gate.** A thread whose line has moved becomes *outdated*,
  not *resolved*, and outdated threads still count. Fix the code, push, then resolve the
  conversation — a PR that sits green and un-queued forever is usually this.
  `scripts/pr-threads.sh <pr>` lists what is still open (with the outdated ones marked, because
  they still count); `scripts/pr-threads.sh <pr> --resolve <thread-id>` closes one. `gh` has no
  built-in for this, so without that script the instruction above names an action you cannot
  perform. It resolves ONE id at a time on purpose: resolving them all in a batch is
  indistinguishable from dismissing the review, which is what the gate exists to prevent.
- **Only INLINE comments create threads.** A top-level PR comment does not, so a review posted as
  one summary comment gates nothing. That is a silent failure of the gate, not of the PR.

Until the gate has ridden `dev → staging → main` (Mergify reads its config only from the default
branch), the only thing that actually holds a PR back is opening it as a **draft**.

Letting Mergify land it is the default and almost always right. Merging a **dev**-targeted PR
yourself is permitted when you have a reason. Merging into `staging`/`main` is not, and neither
is `--admin`, which bypasses the queue entirely. Never merge a red PR.

**Claiming board work:** don't hand-pick. Read **`.claude/COORDINATION.md`** and run
`scripts/claim-work.sh --class backend`, then `pnpm wt` the printed slug. Build only within the
issue's `scope:` globs and reference `Closes #<n>` in the PR.

## 5. Database & migrations

The drizzle snapshot chain is **linear and un-mergeable**. Two branches that each run
`db:generate` off the same base produce two snapshots with the same parent — a permanent
collision that jams generation for everyone.

So: **rebase onto the target branch first**, and never generate in two worktrees at once
(`scripts/db-generate.sh` is lock-guarded and warns). If both your branch and the target added
a migration, delete yours, rebase, regenerate.

Full pipeline, JSONB typing and drizzle-zod: **`.claude/skills/db-pipeline/SKILL.md`**.

## 6. Code style

- Never use `any`. Use the real type, or `unknown` with narrowing.
- Never use `as` casts. Types are inferred from the Drizzle schema — there is no generated
  types file.
- Never use `Record<string, unknown>` for a JSONB field with a known shape; define the
  interface in `apps/console/types/jsonb.types.ts`.
- All functions get a brief JSDoc saying what they do.
- `react-hook-form` for all forms (never raw `useState`); `zod` for all user input.
- Group components by feature/domain (`components/connectors/`), not by type.
- Renamed component files are **deleted**, not left as re-exports.
- Tailwind + the shared shadcn/ui system in `@repo/ui` — import `@repo/ui/button`. There is no
  longer a `components/ui/` in the console (#2881 emptied it), and `components.json` points
  `aliases.ui` at `@repo/ui` so `shadcn add` cannot recreate one.
- The console has ONE chat-message family: `apps/console/components/ai-elements/`. Both the agent
  transcript and support threads render through it.
- Shared web code is **promoted** to `packages/<name>` (npm scope `@repo/*`), never duplicated
  across apps.
- Never start coding without a plan and explicit approval.

### The console's shared surface — reach for these BEFORE writing one

Each line below replaced between two and six hand-rolled copies. The rule is the same every
time: **if two pages disagree about how something looks or reads, the user is being told the
product is two products.**

| Need | Use | Never |
|---|---|---|
| A duration, date, size, quota or amount | `@repo/format` | a local `formatDate`, `toFixed`, or `/ 1024` |
| A page or section heading | `@repo/ui/page-header` — `PageHeader`, with `level` | a bespoke `<h1>` + description block |
| An empty list, tab or panel | `@repo/ui/empty` — `EmptyState` | a one-off centred div |
| A status pill | `@repo/ui/status-badge` | a `<Badge>` plus a local colour map |
| A table | `DataTable`, or `@repo/ui/table` for shapes it cannot express | a `<div className="grid">` |
| A layer above the page | a `--z-*` token from `packages/brand/src/tokens.css` | a bare `z-50` or `z-[95]` |
| A list-page filter | the console filter standard, **both halves** | a per-page filter language |

Three of those deserve their reason stated, because the reason is what makes them stick:

**Minutes are read by a person.** `0.943 minutes / 200 minutes` is a number the code happens to
hold, not an answer to "how much have I used". `formatMinutes` / `formatQuota` decide once —
`<1 min`, `47 min`, `2h 15m` — so a plan card and a usage table cannot disagree.

**A `<div className="grid">` is not a table.** It reads to a screen reader as a stack of
buttons. There were three shells and a fourth with no header row at all, so its columns were
unlabelled.

**The filter standard has a server half.** `apps/console/lib/query/README.md` is the client
half; `apps/console/lib/queries/` holds the `query*Page` builders and `facets.ts`. A facet's
counts come from the **unfiltered** universe — every builder issues a filtered rows pass and a
separate facet pass that sees only the scope predicates. Filter in memory and the option you
just picked disappears, which makes the filter bar un-un-selectable.

No stat-card strips.

`pnpm check:shared-surface` mechanises **five of the seven rows above, plus the stat-card ban**. It
fails on `toFixed(`, `toLocaleDateString`, `toLocaleTimeString`, a hand-written `$` in front of an
interpolation (including one built from a variable or taken as a `prefix` prop), and a byte division
by 1024; on a raw `<h1>` **and now on a hand-rolled `<h2>` through `<h6>` section heading**; on a
centred one-off empty state (`text-center` with `py-6` or more); on a `<Stat` cell and the `Stat`
primitive behind it; on a raw stacking level of 40 or more, variant prefix or not; and on a
`grid-cols-[…]` used as a table.

Two of those are stated precisely on purpose, because the imprecise version is wrong. **The z-index
rule is not "no bare `z-*`"** — `packages/brand/src/tokens.css` puts its in-flow lifts at 10/20/30
and its chrome at 100, so `z-10` is a real rung written without its name while `z-40`/`z-50` name a
level in the gap the scale leaves empty. **And the table rule is a SHAPE test, not a class-name
match**: a bracketed column template that is NOT behind a breakpoint, plus a row marker. A table's
columns are the same at every width, so `lg:grid-cols-[280px_1fr]` is a two-pane layout stacking on
a phone and is not a table.

Where each of those bounds runs to the edge of the rule rather than to the edge of what was measured,
that is deliberate: a guard whose cheapest escape route is to deepen the defect — demote the `<h2>`,
raise the padding, add a `md:` prefix — is worse than no guard.

**Two rows stay prose, and the file says why**: `StatusBadge`, which has no negative form to match
("a page that should have shown a status pill and showed a `<Badge>`" is not a grep), and the filter
standard's server half, which is a behaviour and needs a unit test. A direct `date-fns` import and a
bare `.toLocaleString(` are also still unmatched, deliberately — as is a class list split across two
`cn()` arguments. **Read the omissions in `scripts/check-shared-surface.mjs` rather than inferring
them from this list**: it states every one of them, with the exact token shape and the exact console
directories each matcher reaches, because an unstated exception is how the next reader concludes the
whole table is enforced.

The allowlist carries **two ledgers, and the difference is load-bearing**. `reason:` is a decision —
this surface is genuinely a different thing — and counts against `baseline`. `lifts:` is measured
drift that a named board issue will remove, and counts against `debt`. Both are checked in both
directions, so converting drift into a fix moves two numbers in one diff, and neither list may grow
silently. A `reason:` that means "we haven't got to it yet" is what the split exists to prevent.

Two further checks back up the section rather than restating it: `pnpm -F console check:dead-code`
fails on an unreferenced module or an unused dependency, and `pnpm -F console check:action-boundary`
on a server action that escapes its boundary.

## 7. The harness itself

Four hooks gate every session (`.claude/settings.json`):

| Hook | Event | What it does |
|---|---|---|
| `.claude/hooks/guard-worktree.sh` | PreToolUse · Bash + edits | Lease enforcement + no commits **or rebases** in the main checkout |
| `.claude/hooks/guard-runtime.sh` | PreToolUse · Bash | Blocks local dev servers and destructive resets |
| `.claude/hooks/guard-compose.sh` | PreToolUse · Bash | Blocks a raw `docker compose` bring-up |
| `.claude/hooks/guard-merge.sh` | PreToolUse · Bash | Resolves a PR's base branch: `dev` may merge, `staging`/`main` and `--admin` may not |
| `.claude/hooks/guard-iac.sh` | PreToolUse · Bash | Refuses `tofu`/`terraform` apply, destroy and `plan -destroy` — including the flag-first forms a permission rule cannot match |
| `.claude/hooks/check-migration-chain.sh` | PostToolUse · edits | Reports a forked drizzle snapshot chain at edit time, not at commit time |
| `.claude/hooks/session-runtime.sh` | SessionStart | Runtime banner, and warns when the harness you are running is stale |

Beyond the hooks, `.claude/settings.json` carries a **permission policy**. `deny` is absolute
— it beats any allow rule and any hook — and covers the things that cannot be undone:
`tofu`/`terraform` apply and destroy, pushes to `main`/`staging`, `docker compose down -v`,
and reads or edits of credential files. `allow` pre-approves the routine read-only commands
so the prompts you do see are meaningful.

**A footgun worth knowing:** `guard-runtime.sh` matches **inside quotes**, deliberately — so
`sh -c "…"` cannot smuggle a blocked command past it. The cost is that merely *writing* a
blocked command into a file from a Bash heredoc is also refused. Use the Write/Edit tools for
that; they are not matched.

**The harness you run is the MAIN CHECKOUT's.** Hooks, `settings.json` and CLAUDE.md all
resolve through `$CLAUDE_PROJECT_DIR`, so a session working in a worktree is still gated by
`app/`'s copies. `app/` is pinned to `dev` but is not auto-pulled, so it drifts — and a fix
to a guard cannot take effect for the session that wrote it. The SessionStart banner warns
when this has happened; `git -C <main checkout> pull --ff-only` is the fix.

`.githooks/pre-commit` and `pre-push` are the second layer: they run at commit time with the
real working directory, and they also check the migration chain and SPDX headers.

### Codex harness

Codex uses the project layer in `.codex/`: `config.toml` enables autonomous routine execution
inside the trusted workspace, `hooks.json` adapts the guards above, and `rules/default.rules`
contains the small project command baseline. Run `pnpm codex:doctor` to validate the setup and
`pnpm codex:self-test` to exercise the guards and adapters.

The Codex hooks must be reviewed and trusted once with `/hooks` after first launch or whenever a
hook definition changes. This is a one-time hook trust step, not a per-command approval prompt.
After an implementation request, Codex may edit, run checks, commit, push the feature branch,
and open a PR into `dev` without asking again. The same protected actions remain blocked by the
Codex hooks and `.githooks/`; use `gh` CLI for GitHub delivery so it follows the repository policy.

Codex discovers the shared workflows through `.agents/skills/`. Those entries link to the
canonical `.claude/skills/` directories. Update the canonical skill and run
`pnpm codex:doctor`; do not fork or edit a linked copy.

## 8. Where the truth lives

| Topic | Source |
|---|---|
| **The MVP programme — what is proven, what is next, what is blocked on the maintainer** | **`PROGRAMME.md`** (read it first; its status half is generated, never typed) |
| Running the app, envs, the box | `.claude/skills/dev/SKILL.md`, `infra/sandbox/README.md` |
| Claiming work, the board, the autonomous loop | `.claude/COORDINATION.md` |
| DB pipeline, JSONB, drizzle-zod | `.claude/skills/db-pipeline/SKILL.md` |
| Per-component architecture (console · CLI · runner · core · packages · marketing · docs · admin · ee) | `ARCHITECTURE.md` |
| Testing bar, coverage gates | `TESTING.md` |
| Contributing, branch flow, CI | `CONTRIBUTING.md` |
| Docs style bar (Diátaxis + Vale) | `apps/docs/README.md`, `.claude/skills/alethia-docs/SKILL.md` |
| Security review before shipping | `.claude/skills/alethia-security-review/SKILL.md` |
| IaC rules | `infra/README.md` |
| Open-core boundary | `ee/README.md`, `LICENSING.md` |
| The verification gate (elench) | `ELENCH.md`, `packages/core/verify/README.md` |

**Working discipline** — reach for the right tool by default. Big or ambiguous task → decompose
onto the board (`.claude/skills/decompose/SKILL.md`). Any non-trivial plan → grill it first
(`.claude/skills/grilling/SKILL.md`). Unknowns → research against primary sources
(`.claude/skills/research/SKILL.md`). Security-sensitive change → run the security review.
Handing off → `.claude/skills/handoff/SKILL.md`. Module boundaries →
`.claude/skills/codebase-design/SKILL.md`.
