# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# GitHub Actions OIDC provider. One per account — the SES bootstrap already created it,
# so the default here ADOPTS the existing provider (create_oidc_provider = false; pass
# its ARN via oidc_provider_arn). Set create_oidc_provider = true only in an account
# that doesn't have one yet.

data "tls_certificate" "github" {
  count = var.create_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github[0].certificates[0].sha1_fingerprint]
  tags            = local.tags
}
