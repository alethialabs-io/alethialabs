# Contributing to Alethia Labs

Thanks for your interest in contributing! Alethia Labs is an **open-core** project:
the core is open source under `AGPL-3.0-only`, and a small set of enterprise
features under [`ee/`](ee/) is commercially licensed. This guide explains how to
contribute and the one legal step we require.

## Contributor License Agreement (CLA)

> **Formation gate:** Alethia Labs DPK has been submitted for registration but
> does not yet have an EIK. We welcome issues and discussion, but cannot merge
> third-party code until the registered company is identified and the
> post-registration CLA is activated. The required `contribution-legal` check
> enforces this automatically.

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
5. Open a pull request. While formation is pending, external PRs remain
   reviewable but cannot merge. After activation, sign the CLA when prompted.

## Branching & release flow

Three long-lived branches promote right-to-left; `main` is protected and only ever
receives merges from `staging`.

| Branch | Role | Merges from | Deploy |
|---|---|---|---|
| `dev` | integration — all feature/fix PRs land here | feature branches (non-draft PR + green CI, **via the Mergify queue**) | — (CI only) |
| `staging` | release candidate | `dev` (PR + green CI) | — (built/tested; no deploy yet) |
| `main` | production | `staging` **only** (PR + green CI, linear history) | auto → alethialabs.io (`deploy-console.yml`) |

- **`main` is protected:** requires a PR, all CI status checks green, up-to-date branch,
  linear history; force-push/deletion blocked; admins included. No direct pushes — ever.
  **0 required approvals** (solo repo — you can't approve your own PR); bump
  `required_approving_review_count` in `infra/github` when a second reviewer exists.
- **`dev` uses a merge queue — Mergify, not GitHub's native one.** Just open a **non-draft**
  PR into `dev`. Mergify (`.mergify.yml`) auto-queues every non-draft, conflict-free dev PR and
  squash-merges it in order once the **9 required checks** pass, validating each PR on its own
  branch (it rebases candidates itself). That is what makes concurrent PRs safe: you never merge
  against a `dev` that moved under you, so two green-against-stale PRs cannot race and break the
  branch. Keep work-in-progress as a **draft** — drafts are excluded. If Mergify reports a
  conflict, rebase onto `origin/dev` and push; it re-queues automatically. You can nudge it with
  a `@mergifyio requeue` comment.

  You do not need to merge anything yourself, and you must never use `--admin` (it bypasses the
  queue) or merge a red PR. The heavy real-runner and browser E2Es run as observe-only signals,
  tracked by `scripts/merge-signal-health.sh` and the weekly *Merge-signal health* workflow.

- **`staging` is protected too** (PR + green CI), lighter than `main`.
- **release-please** runs on `main` and opens the release PRs (CLI + runner version
  bumps); this flow is unchanged by the branch model.
- A production release is a `staging → main` PR. Hotfixes still go through
  `dev → staging → main` unless it's a true emergency (cherry-pick to `staging`).

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
