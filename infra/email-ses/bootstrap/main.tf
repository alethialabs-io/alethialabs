# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bootstrap for the SES stack (account 270587882865). Owns all IAM so the main
# stack — applied by CI — needs none: the GitHub-OIDC deploy role + its
# least-privilege policy, and the scoped send policy on the existing runtime
# sender. Apply this ONCE with an admin/root identity (the only privileged step);
# everything after runs as the least-priv deploy role. Codified → redoable.

locals {
  tags = {
    project = "alethia"
    role    = "email-ses-bootstrap"
    managed = "opentofu"
  }

  region     = var.aws_region
  account_id = data.aws_caller_identity.current.account_id

  # Constructed ARNs (the main stack creates these by the same names) — so the
  # send policy + deploy-role scoping don't need a cross-stack dependency.
  identity_arns = [
    for k, s in var.streams :
    "arn:aws:ses:${local.region}:${local.account_id}:identity/${s.subdomain}.${var.domain}"
  ]
  config_set_arns = [
    for k, s in var.streams :
    "arn:aws:ses:${local.region}:${local.account_id}:configuration-set/alethia-${k}"
  ]

  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.oidc_provider_arn
}

data "aws_caller_identity" "current" {}
