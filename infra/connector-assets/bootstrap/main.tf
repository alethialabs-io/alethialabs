# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bootstrap for the connector-assets stack (account 270587882865). Owns all IAM so the
# main stack — applied by CI — needs none: the GitHub-OIDC deploy role + its
# least-privilege policy (manage exactly the one assets bucket + its objects, and read/
# write the OpenTofu state object). Apply this ONCE with an admin identity (the only
# privileged step); everything after runs as the least-priv deploy role. Codified →
# redoable. The account's GitHub OIDC provider and the state bucket already exist (from
# infra/email-ses/bootstrap) — both are adopted here, not recreated.

locals {
  tags = {
    project = "alethia"
    role    = "connector-assets-bootstrap"
    managed = "opentofu"
  }

  region     = var.aws_region
  account_id = data.aws_caller_identity.current.account_id

  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.oidc_provider_arn
}

data "aws_caller_identity" "current" {}
