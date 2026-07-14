<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
| `alethia-e2e-nightly` | `e2e-nightly.yml` (schedule/dispatch **only**) | Provision + tear down an ephemeral AWS EKS estate — see below |

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

## `alethia-e2e-nightly` — the T2 real-cloud provisioning role (BYOC A1.1)

`e2e-nightly.tf` + `e2e-budget.tf` add the identity the T2 nightly (`.github/workflows/e2e-nightly.yml`)
assumes to stand up + tear down a **genuine, ephemeral AWS EKS cluster** from
`infra/templates/project/aws`. This is the AWS enabler for the second-cloud real provision
(Hetzner is cloud #1).

A provisioning identity is inherently broad — you can't enumerate a least-privilege action list
for "build + destroy a whole EKS estate" without it breaking on the next template change. So the
security model is **defense by guardrail**, and every guardrail is asserted in `checks.tf`:

1. **Ref-bound OIDC trust** — only Actions runs whose OIDC `sub` is *exactly*
   `repo:<repo>:ref:refs/heads/<e2e_github_branch>` (default `main`, the branch `schedule` runs on)
   may assume it. `StringEquals`, never `StringLike` — no PR, fork, or sibling branch/repo can match.
   `aud` is pinned to `sts.amazonaws.com`. (Optionally also an exact `:environment:<env>` sub.)
2. **Permissions boundary** (`alethia-e2e-nightly-boundary`) — an un-removable ceiling. The role is
   *denied* the IAM calls that could edit its own boundary/trust (self-tamper deny on `/alethia-e2e/`),
   so the wall can't be lowered from inside. It strips out: any region but `e2e_region`
   (`aws:RequestedRegion` lock), the prod tofu-state bucket, the prod secret vault, attaching an
   AWS-managed admin/*-full policy (escalation), and all `organizations:*` / `account:*`.
3. **Region lock to a non-prod region** — `e2e_region` defaults to `us-east-1` (cheapest EC2, the
   global-service home) and is validated to never be a prod region (`eu-central-1` state/SES,
   `eu-west-1` fleet), so a runaway run can't touch prod. Global services (IAM/STS/Route53/CloudFront/
   WAF-global/Budgets) are carved out of the lock.
4. **Monthly Budget + SNS** (`e2e-budget.tf`) — a cost kill-signal at 50/80/100 % actual + 100 %
   forecast of `e2e_monthly_budget_usd` (default \$100), by email + onto an SNS topic (hang an
   automated account kill-switch off it later). Budgets is us-east-1-homed (aliased provider).

All IAM entities the role family creates are path-scoped under `/alethia-e2e/`.

### Enable the AWS nightly (maintainer)

```bash
# 1. Apply the stack (adds the e2e role + boundary + budget alongside the deploy roles).
#    Pass the alert emails so the budget can notify you.
tofu apply -var 'e2e_budget_alert_emails=["you@alethialabs.io"]'

# 2. Publish the role ARN as the repo Actions VARIABLE the nightly gates on.
gh variable set E2E_AWS_ROLE_ARN -b "$(tofu output -raw e2e_nightly_role_arn)"
```

Until `E2E_AWS_ROLE_ARN` is set, the AWS path of `e2e-nightly.yml` **green-skips** (mirrors the
Hetzner `HCLOUD_TOKEN` gate). A1.1 ships the identity + the `aws` dispatch choice; A1.2–A1.4 wire
label-at-source, the `aws-cleanup.sh` sweeper, and the full provision/teardown before AWS joins the
cron. The `id-token: write` used to assume this role lives only on `e2e-nightly.yml`, which triggers
**solely on `schedule` / `workflow_dispatch`** — never `pull_request` (program invariant 1, enforced
by `scripts/check-workflow-oidc-isolation.mjs`).

### Known limitation — the boundary is a blast-radius reducer, not full containment

A permissions boundary caps **this role's** direct actions (region, prod isolation, self-tamper,
admin-managed-policy attachment, role-hop). It **cannot** contain a role that legitimately creates
*other* IAM principals — and this one must (IRSA roles + the template's `aws_iam_user` + access key).
So a run executing on the trusted branch could `CreateUser` + inline `PutUserPolicy *:*` +
`CreateAccessKey` (or `CreateRole` + `PassRole` to an EC2 instance profile) and operate outside the
boundary. The real wall is therefore the **ref-bound OIDC trust**: only trusted-branch runs execute
here, so *"who can run the nightly"* ≈ *"who has latent admin in the shared account."* Because it runs
in the **shared platform account** (`270587882865`), global services (Route53, IAM) also can't be
region-fenced away from prod.

**Recommended before AWS goes to cron (maintainer):** give the e2e nightly its **own dedicated AWS
account** (or wire a per-created-entity permissions boundary into `infra/templates/project/aws` in
BYOC A1.2). This is the AWS analogue of the invariant-3 "separate hcloud account for e2e" decision and
is the clean fix for both the create-principal escape and the shared-account global-service exposure.
