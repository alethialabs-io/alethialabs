# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The `production` GitHub Actions environment — the second half of the OIDC deploy
# control. The AWS deploy roles (infra/aws-oidc + infra/{email-ses,connector-assets}/
# bootstrap) trust `repo:<owner/repo>:environment:production` (the deploy/apply jobs set
# `environment: production`, so GitHub mints that sub). Restricting the environment to
# the main branch is what makes that safe: a job on any OTHER branch cannot select this
# environment, so it can never mint the `:environment:production` sub and assume a role.
# Without this, the environment sub would be obtainable from any branch.
resource "github_repository_environment" "production" {
  repository  = var.repository
  environment = "production"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "production_main" {
  repository     = var.repository
  environment    = github_repository_environment.production.environment
  branch_pattern = "main"
}

# The `e2e-issuer` environment holds the Cloudflare credentials that deploy the E2E assertion
# issuer (.github/workflows/deploy-e2e-issuer.yml) — the Worker four cloud federations trust as
# an OIDC issuer. Same shape and same reason as `production` above, one branch over: the deploy
# workflow guards `github.ref == refs/heads/dev` itself, but a job on any other branch must also
# be unable to SELECT this environment, or a `workflow_dispatch --ref feat/x` on an edited copy of
# the workflow publishes arbitrary code as the trusted issuer.
resource "github_repository_environment" "e2e_issuer" {
  repository  = var.repository
  environment = "e2e-issuer"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "e2e_issuer_dev" {
  repository     = var.repository
  environment    = github_repository_environment.e2e_issuer.environment
  branch_pattern = "dev"
}

# The `cli-release` environment is the CLI release path's own credential scope, and it is the
# ONLY one restricted to a TAG rather than a branch. `release-cli.yml` is triggered by a `cli-v*`
# tag push, so its jobs present `...:ref:refs/tags/cli-vX.Y.Z` — a subject no deploy role trusts
# and, being a tag, one that cannot be pinned by an exact StringEquals the way a branch can. The
# release job selects THIS environment instead, so the sub becomes `...:environment:cli-release`,
# which `alethia-deploy-reader` (and only that role) trusts.
#
# The tag pattern is what keeps that safe, and it is why this is a NEW environment rather than a
# `cli-v*` policy added to `production`: `environment:production` is trusted by EVERY deploy role
# (state write, ECR push, ECS roll), so making it selectable from a tag push would widen the whole
# OIDC deploy control to "anyone who can push a tag". `cli-release` reaches one read-only role that
# can read one secret, and `production`'s branch policy is left exactly as it was.
resource "github_repository_environment" "cli_release" {
  repository  = var.repository
  environment = "cli-release"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

# A TAG policy, not a branch policy — `custom_branch_policies = true` above is what enables custom
# patterns of either kind; `tag_pattern` is what makes this one match `refs/tags/cli-v*` and NO
# branch at all. So no job on any branch can select this environment.
#
# WHAT THIS DOES NOT DO, stated because this comment is what somebody reads when deciding whether
# to widen alethia-deploy-reader. `cli-v*` is a GLOB, with no relationship to release-please or to
# any version anchor: it constrains the ref SHAPE and nothing about who created the ref. Every
# ruleset in main.tf is `target = "branch"`, so nothing in this repository restricts tag creation —
# anyone with write access can push a matching tag and reach this environment.
#
# That is accepted rather than overlooked. The environment holds no secret, and the whole grant it
# unlocks is one read-only `GetSecretValue` for the release bearer, so the blast radius is a false
# release-metadata post rather than anything that writes infrastructure. A `target = "tag"` ruleset
# over `cli-v*` is what would tighten it, and it has to be weighed against release-please's own
# tagging rather than added blind. Do NOT read this policy as an authorship control.
resource "github_repository_environment_deployment_policy" "cli_release_tags" {
  repository  = var.repository
  environment = github_repository_environment.cli_release.environment
  tag_pattern = "cli-v*"
}

# The `spend-report` environment is the weekly spend report's credential scope
# (.github/workflows/spend-report.yml). Three identities trust ITS subject and nothing else:
# `alethia-spend-reporter` (infra/aws-oidc/spend-reporter.tf — Cost Explorer, the tagging API, and a
# READ of the prod secret for the Resend key), the Azure Cost Management Reader SP
# (infra/azure-e2e/spend-reporter.tf) and the GCP billing-viewer SA (infra/gcp-e2e/spend-reporter.tf).
#
# A dedicated environment rather than `production`, because `production` is trusted by every deploy
# role — state write, ECR push, ECS roll — and a read-only report has no business presenting a subject
# that reaches them. A dedicated environment rather than the bare `ref:refs/heads/main` subject,
# because that one is presented by EVERY workflow on main, while this one is presented only by a job
# that names it.
#
# The `main` policy is the load-bearing half, exactly as for `production`: without it any branch could
# select the environment and read the prod secret through the AWS role. GitHub creates an environment
# UNRESTRICTED the first time a job names one that does not exist, so this resource must be applied
# BEFORE infra/aws-oidc creates the role, not after.
resource "github_repository_environment" "spend_report" {
  repository  = var.repository
  environment = "spend-report"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "spend_report_main" {
  repository     = var.repository
  environment    = github_repository_environment.spend_report.environment
  branch_pattern = "main"
}
