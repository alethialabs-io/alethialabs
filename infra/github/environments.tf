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
