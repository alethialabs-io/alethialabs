<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# aws-oidc

Least-privilege **GitHub-OIDC deploy roles** for the CI workflows that previously used
static AWS keys. Removes `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `TF_STATE_S3_*`
from those workflows — they assume a scoped role via OIDC instead.

| Role | Assumed by | Grants (only) |
|---|---|---|
| `alethia-cp-deployer` | `infra-cp-hetzner.yml`, `infra-status.yml` | S3 state on `hetzner/*` + `status/*`; read/write the `alethia/prod/env` secret (read TF-var inputs, write `TUNNEL_TOKEN`/`DEPLOY_HOST`) |
| `alethia-deploy-reader` | `deploy-console.yml` | **read** the `alethia/prod/env` secret only |
| `alethia-runner-release-deployer` | `release-runner.yml`, `deploy-fleet-aws.yml` | ECR push to the runner repo + `ecs:UpdateService` on the one service |

This module also creates the **`alethia/prod/env` Secrets Manager container** (`asm.tf`) —
the single vault for all runtime + infra secrets. Only the container is created here;
values are written by `scripts/bootstrap-secrets.sh` (internals + externals) and by CI
(`TUNNEL_TOKEN`/`DEPLOY_HOST`), never in OpenTofu state.

Trust is scoped to `repo:<github_repo>:ref:refs/heads/<github_branch>` (main only — PR
jobs can't assume). Both `github_repo` and `github_branch` are variables, so switching
to an org repo later is a var change. The account-wide GitHub OIDC provider is **adopted**
(a `data` source), not re-created — it already exists from `infra/email-ses/bootstrap`.

## Apply (once, with an admin identity)

This is a bootstrap: it creates IAM, so it needs admin the first time (like
`infra/email-ses/bootstrap`). Run via the `bootstrap.yml` workflow (assumes a
bootstrap-admin role) or locally:

```bash
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars   # edit if repo/account differ
tofu init -backend-config=backend.hcl
tofu apply
```

Then publish the outputs as repo **Actions variables** (the `infra/github` module does
this automatically; manual fallback):

```bash
gh variable set CP_HETZNER_DEPLOYER_ROLE_ARN     -b "$(tofu output -raw cp_deployer_role_arn)"
gh variable set RUNNER_RELEASE_DEPLOYER_ROLE_ARN -b "$(tofu output -raw runner_release_deployer_role_arn)"
gh variable set DEPLOY_READER_ROLE_ARN           -b "$(tofu output -raw deploy_reader_role_arn)"
```
