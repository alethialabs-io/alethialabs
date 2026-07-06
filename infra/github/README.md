<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# github (repo-as-code)

Repo governance as OpenTofu (provider `integrations/github`): the `dev` branch, the
`main`/`staging` protection **rulesets**, and the deployer-role **Actions variables**.
This is the source of truth — the `gh api` snippets in `deploy/prod/README.md` are a
manual fallback only.

- **`main`**: PR required, **0 approvals** (solo repo — CI is the gate), all CI checks
  green, no force-push/deletion, admins included. **Merge commits allowed** (NOT linear
  history) — `staging → main` promotes as a merge so main stays convergent with dev/staging;
  requiring linear history forced squash promotions that diverged the graph and made the next
  promotion falsely conflict.
- **`staging`**: PR + CI (lighter — allows hotfix merges).
- **`dev`** (`protect-dev`): created off `staging`; feature PRs target it. **PR + green CI, 0 approvals**
  — instances self-merge once CI is green (the CI list minus `branch-flow-guard`, which only runs on
  PRs into main/staging). No force-push/deletion. This is the gate into the shared integration branch;
  the maintainer reviews the integrated `dev` (dev.alethialabs.io) and promotes `dev → staging → main`.

`github_owner`/`repository` are variables → switching to an org repo is a var change.

## Auth (your own `gh` token — no App)

Applied **locally, once** as part of the admin bootstrap. The provider needs a token with
**Administration** (rulesets), **Contents** (create `dev`), and **Actions variables** write
— as the repo owner/admin, `gh auth token` already has this. Pass it as
`-var github_token=$(gh auth token)`. (No GitHub App: all runtime secrets live in AWS
Secrets Manager, so nothing in CI needs to write GitHub secrets.)

## Apply

> **Apply from an up-to-date `main`, and only with the role-ARN `-var`s below.** A bare
> `tofu apply` (no vars, or from a `dev`/`staging` checkout) plans a **destroy** of the
> deployer-role Actions vars (they are `count`-gated on those vars) and — if the checkout
> predates a resource here — of the `production` environment (`environments.tf`), which is
> the OIDC deploy control. `environments.tf` lives on every branch now, but the vars still
> make apply non-destructive, so never bare-apply. (`plan -destroy`/`apply` from an agent is
> forbidden — see root `CLAUDE.md`.)

Normally run by `bootstrap.yml`. Locally:

```bash
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu apply \
  -var "github_token=$(gh auth token)" \
  -var "cp_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw cp_deployer_role_arn)" \
  -var "runner_release_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw runner_release_deployer_role_arn)" \
  -var "deploy_reader_role_arn=$(cd ../aws-oidc && tofu output -raw deploy_reader_role_arn)"
```

> If `dev` or a ruleset already exists, import it first (`tofu import
> github_branch.dev <repo>:dev`, `tofu import github_repository_ruleset.main
> <repo>:<ruleset_id>`) so apply adopts rather than fails.
