# Contributing to Alethia Labs

Thanks for your interest in contributing! Alethia Labs is an **open-core** project:
the core is open source under `AGPL-3.0-only`, and a small set of enterprise
features under [`ee/`](ee/) is commercially licensed. This guide explains how to
contribute and the one legal step we require.

## Contributor License Agreement (CLA)

> **CLA activation gate:** ALETHIA LABS is registered as a Bulgarian single-member
> variable capital company under EIK 208913663.
> We welcome issues and discussion, but cannot merge third-party code until the
> versioned post-registration CLA is activated and the required
> `contribution-legal` check passes.

After activation, every external contributor must sign the versioned Contributor
License Agreement before a contribution can merge. The signature record is tied
to the exact CLA version and document hash.

- **Individuals** sign the [Individual CLA](cla/ICLA.md) via the bot.
- **Contributing on behalf of an employer?** Your employer must also have a
  countersigned [Corporate CLA](cla/CCLA.md) on file (email it to
  legal@alethialabs.io) **before** your PR is merged — the in-PR signature records
  only the Individual CLA.

**Why a CLA?** Alethia Labs offers both an AGPL core and a commercial edition. To
keep offering both, Alethia Labs needs the right to license your contribution under
both licenses. The CLA grants Alethia Labs that right while **you keep the copyright
to your contribution** — it is a license, not an assignment. Without it, a single
AGPL-only contribution would block us from shipping the commercial edition.

## How to contribute

1. Fork the repo and create a branch from `dev` (the integration branch — see
   *Branching & release flow* below). PRs target `dev`, not `main`.
2. Make your change. Add an SPDX header to every new source file:
   - Core code: `SPDX-License-Identifier: AGPL-3.0-only`
   - Code under `ee/`: `SPDX-License-Identifier: LicenseRef-Alethia-Commercial`
   - Plus a copyright line: `SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>`
3. Match the existing code style and run the relevant checks:
   `turbo build`, `turbo lint`, and `go test ./...` for Go packages.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) — releases are
   automated with release-please.
5. Open a pull request. Until the CLA activation gate is complete, external PRs
   remain reviewable but cannot merge. After activation, sign the CLA when prompted.

## Branching & release flow

Feature work lands on `dev`; production is `main`, and `main` receives a dev commit through a
**pinned promotion PR**: `.github/workflows/promote.yml` creates `release/<12-char sha>` at one
green dev commit, never moves it, and opens `release/<sha> → main`. The `staging` hop is retired
(maintainer decision, 2026-11-22): it deployed nothing, and its standing PR — whose head
was `dev` — restarted ~9 workflows on every queue merge (220 cancelled runs in one week) while its
~50-minute release gate never finished before `dev` moved again.

| Branch | Role | Merges from | Deploy |
|---|---|---|---|
| `dev` | integration — all feature/fix PRs land here | feature branches (non-draft PR + green CI, **via the Mergify queue**) | — (CI only) |
| `release/<sha>` | one promotion, pinned at one dev commit | created by `promote.yml`; never pushed to | — |
| `main` | production | `release/<sha>` (PR + green CI + all release-gate legs); a `hotfix/*` PR is also admitted, and is the maintainer's | auto → alethialabs.io (`deploy-console.yml`) |
| `staging` | retired — the branch still exists, but nothing merges into it and no ruleset protects it | — | — |

- **Opening a promotion.** `promote.yml` runs twice on weekdays and on dispatch (optional `sha`,
  `force`, `dry_run` inputs). It picks the newest dev commit that is *green* — a successful `CI`
  run, on a `pull_request` or `push` event, for the same commit or the same git tree, which is what
  a Mergify queue build of that batch is (`ci.yml` has no `push: dev` trigger, so a dev commit has
  no run of its own). It does nothing while an older promotion PR is still running or is green and
  waiting for its merge, and closes an older one that went red as superseded.
  `scripts/ci/promote.mjs` holds the rules. The PR is written with the `alethia-labs-ci` GitHub
  App token, because a PR opened with `GITHUB_TOKEN` never starts its checks.

- **`main` is protected:** requires a PR, all CI status checks green, up-to-date branch,
  linear history; force-push/deletion blocked; admins included. No direct pushes — ever.
  **0 required approvals** (solo repo — you can't approve your own PR); bump
  `required_approving_review_count` in `infra/github` when a second reviewer exists.
- **`dev` uses a merge queue — Mergify, not GitHub's native one.** Just open a **non-draft**
  PR into `dev`. Mergify (`.mergify.yml`) auto-queues every non-draft, conflict-free dev PR and
  squash-merges it in order once the **required checks** pass, validating each PR on its own
  branch (it rebases candidates itself). The list itself is not written down here on purpose — a
  count in prose is the fifth place it can go stale, and `.mergify.yml` had already been a month
  out of step with `infra/github/variables.tf` twice. `scripts/ci/check-required-checks.mjs`
  compares the two in-tree lists on every PR, and `workflow-health.yml` reports nightly when the
  live rulesets disagree with either. That is what makes concurrent PRs safe: you never merge
  against a `dev` that moved under you, so two green-against-stale PRs cannot race and break the
  branch. Keep work-in-progress as a **draft** — drafts are excluded. If Mergify reports a
  conflict, rebase onto `origin/dev` and push; it re-queues automatically. You can nudge it with
  a `@mergifyio requeue` comment.

  You do not need to merge anything yourself, and you must never use `--admin` (it bypasses the
  queue) or merge a red PR. The heavy real-runner and browser E2Es run as observe-only signals
  **on Mergify's queue builds** (the `mergify/merge-queue/*` draft PRs; T1 runs on every one, the
  browser E2Es when their paths changed), graded by `scripts/merge-signal-health.sh` and the weekly
  *Merge-signal health* workflow — the release gate is a promotion-path check and does not run on a `dev` PR at all
  unless you label it `release-gate:run`, with one exception: its **`qa` leg** runs on every `dev` PR
  that touches the console UI, its e2e specs or the packages it renders (`ci.yml`'s `e2e-qa-leg`,
  which calls `release-gate.yml`; #7647), and it is **required when it runs** — a `needs:` of
  `CI required`, so a ratchet regression blocks the merge. It is about ten runner minutes, runs in
  the merge queue's batch (the full lane, below), and is documented in `TESTING.md`. See the
  promotion checklist below.

- **Two CI lanes: a fast one on your PR, the full suite in the queue.** `ci.yml`'s `detect-changes`
  job sets `lane`. An ordinary PR into `dev` runs the **fast lane**: lint and types, the affected
  unit suites and coverage ratchets, the build smoke, Go for the affected modules, the guards,
  docs prose, the secret scan, `capabilities-security`, the gate ledger and the path-conditional
  observe-only E2Es. The **full lane** adds the jobs that gate through `CI required` but are too slow
  for a first answer — `Build console images (no push)`, `Integration (real Postgres + RLS)`, the
  `BYO users SQL — real Postgres` legs and the `qa` leg above — and runs on the Mergify queue's
  batch (`mergify/merge-queue/*`), on promotions, on pushes and on the schedule. Nothing reaches
  `dev` without the batch's full-lane `CI required` passing, and that job fails a full-lane run in
  which any of those jobs skipped when it should have run, or a run that calls itself `fast` but is
  not an ordinary dev PR. So a red in one of those jobs shows up when the batch fails (Mergify
  reports it on your PR and drops it from the queue), not on your first push. The lane table and the
  reason for each job is the `TWO LANES` comment in `ci.yml`. Setting `AFFECTED_ONLY_ARMED` to
  `"false"` in that job turns the fast lane off, so every PR runs the full lane again.

- **Why the promotion head is pinned.** The old `dev → staging` promotion PR lived as a DRAFT
  between promotions, because a draft does not fire the release gate. Its head was an integration
  branch, so every merge into `dev` was a `synchronize` on it — and its
  diff was everything `dev` was ahead of `staging` by, which matches nearly every path filter in the
  repo. Measured 2026-09-03 over 500 runs: one standing promotion PR was **22% of all CI runs**,
  firing ~9 runs across 9 workflows on every single merge, to re-validate a promotion nobody was
  promoting.

  That matters more than the share suggests, because **CI here is rationed by runner slots, not
  minutes**: in the same sample jobs spent 5,376 minutes waiting for a runner against 1,802
  executing, and a run had all its ready jobs running only after ~35 minutes. A five-second job
  that waits twenty minutes holds a slot for twenty minutes. `workflow-health.yml` reports the
  demand daily (*CI demand*) so this is visible rather than rediscovered — see #4173.

- **`staging` is no longer protected or promoted through.** Its `protect-staging` ruleset was removed
  from `infra/github` with the hop (it stops binding once that stack is applied), `branch-flow-guard`
  no longer runs on PRs into it, and `.claude/hooks/guard-merge.sh` refuses any merge into it. The
  branch itself is kept.
- **release-please** runs on `main` and opens the release PRs (CLI + runner version
  bumps); this flow is unchanged by the branch model.
- A production release is a `release/<sha> → main` PR. Hotfixes still go through `dev` and a
  promotion unless it's a true emergency (a `hotfix/*` PR into `main`, which is the maintainer's).

### Promoting to `main` — the checklist

**Agents run promotions when they are green** (maintainer ruling, 2026-11-06). The merge is
`gh pr merge <n> --merge --match-head-commit <head sha>`, and `.claude/hooks/guard-merge.sh` admits it
only for a `release/<sha> → main` PR (opened by the `alethia-labs-ci` app, its head a dev commit
named by the branch) whose `gh pr checks` shows nothing failed or
pending and whose every `Release gate (<leg>)` from `.github/workflows/release-gate.yml` passed,
for exactly that head. It refuses `--squash`, `--rebase`, `--auto`, `--admin`, `--delete-branch`
and a command holding more than one merge. The checklist below is what "green" means.

**Before the merge.**

1. **Let the promotion PR's checks finish.** Its head never moves, so they run once; a newer
   promotion is not opened over it while they run.
2. **Wait for all seven `Release gate (…)` contexts** — `hero`, `elench-ai`, `console`, `canvas`,
   `qa`, `audit`, `audit-interaction`. Each boots its own ephemeral console and drives one
   Playwright project against it; `release-gate.yml`'s own header budgets the set as a one-hour
   gate, which is why it is kept off the per-merge path. Adding an unrelated label to the PR while
   they run is safe — the concurrency group refuses to cancel on a `labeled` event, for exactly
   that reason.
3. **Read the step summaries, not the job colours.** Each leg is *green-by-ratchet*: the Playwright
   step carries `continue-on-error`, and the only step that can fail the job is the ratchet against
   `apps/console/e2e/gate-baseline.json`. So a green leg means "no regression against the recorded
   debt", never "the suite passes", and the summary is where the leg says which tests it counted.
4. **Never lower a baseline in a promotion PR.** The baseline is shrink-only and is regenerated with
   `node scripts/e2e-ratchet.mjs --project=<leg> --results=… --write --only=<spec file>` in the
   *feature* PR that fixed the test. A promotion PR that edits the ledger is a promotion PR that
   moved the bar to fit the result.

**What actually blocks what — and none of it is in force yet.** Measured 2026-09-09: every piece
of the gate lives on `dev` and on `dev` only. `release-gate.yml`, `gate-baseline.json`,
`scripts/e2e-ratchet.mjs`, the post-deploy smoke script and the `/console-prod-qa` skill are all
absent from `origin/staging` and `origin/main`. So read the three mechanisms below as what the
gate *will* do on the promotion after this one, not as what is guarding today's:

- **Branch protection — declared, never applied.** `infra/github/variables.tf` names all seven
  `Release gate (…)` contexts as required on `main`, and `main.tf` filters them out of `dev` and
  `staging`. That stack has not been applied (#4286 is the maintainer's `tofu apply` — an absolute
  `deny` rule refuses it to agents). The live `protect-main` ruleset carries ten contexts and not
  one of them is a gate leg. That is the shape #1625 and #3180 both record: a requirement written
  down in unapplied HCL, which nothing enforces.
- **The workflow runs from the PR's head.** A `pull_request` run resolves the workflow from the
  head branch, so a `dev → staging` promotion PR *will* fire the gate — `dev` has the file — while
  a `staging → main` PR fires nothing until that first promotion carries it to `staging`. Expect
  the first `staging → main` promotion after this wave to be the first one the gate has ever seen.
- **The deploy receipt — the one that will bite.** `deploy-console.yml`'s `preflight` job gates the
  entire deploy graph: it finds the merged `main` PR containing the pushed commit and requires the
  latest `Release gate (<leg>)` check-run for **every** leg, derived from `release-gate.yml`'s own
  leg table rather than a second list, to be `success`. Once `deploy-console.yml` reaches `main`
  carrying that step, a commit promoted without a green gate cannot deploy — including a commit
  promoted from a `staging` that does not yet carry the workflow. Do not route around it by
  dispatching *Deploy Console* manually; the receipt step is skipped on `workflow_dispatch` by
  design, and using that as the remedy is the bypass the receipt exists to catch.

**After the merge.** Merging the promotion PR is not the release. The deploy runs *after* it, and
`deploy` is gated `!cancelled() && !failure()`, so a red build silently skips it and `main` moves
while production does not. Between 2026-07-30 and 2026-08-25 that shipped nothing for 26 days
across 15 merges.

1. **Watch the `Deploy Console` run to `deploy: success`** — not merely to "green".
2. **Confirm `Post-deploy smoke (the public URL, and the build it serves)` is green.** This is the
   check that replaced hand-running `docker buildx imagetools inspect`: it runs eleven checks against
   the public site, two of which assert that the served build ids — the console's and marketing's —
   equal the promoted SHA. That is
   the assertion that catches the failure the manual step existed for — `retag-unchanged` retags
   `latest` → the new SHA for an image group that did not change, and on 2026-08-13 it did that to
   a 14-day-old image whose builds had all failed, a green deploy of stale code under a fresh SHA.
   The comparison is skipped with a stated reason on a runner-only push, where the console images
   are legitimately not rebuilt — read the step, because "skipped" and "passed" are different
   answers.
3. **Run `/console-prod-qa`** and open a PR with its report. It is the only layer that measures the
   production *configuration* — the real Stripe keys, OAuth redirect URIs, email sender, DNS and
   storage — in a real browser. The skill is `disable-model-invocation: true` because it mutates
   production: the maintainer names it, no session reaches for it. Reports land in
   `apps/console/docs/qa/prod-runs/`, one dated file per run.

`deploy-console.yml`'s `report-failure` job opens an issue when the run is red, and
`workflow-health.yml` catches a workflow that stays red across runs — but neither replaces looking.

> The protections are **codified** in [`infra/github/`](infra/github/) (Terraform `github`
> provider), applied once locally during bootstrap; a manual `gh api` fallback lives in
> [`deploy/prod/README.md`](deploy/prod/README.md#branch-protection--repo-governance).

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Email
security@alethialabs.io instead. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under
`AGPL-3.0-only` and, per the CLA, may also be offered by Alethia Labs under its
commercial license. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).
