# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  # >= 1.10 for the S3 backend's native `use_lockfile` (no DynamoDB lock table), as infra/aws-oidc.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 5.81: the first release whose aws_iam_openid_connect_provider takes no thumbprint_list
      # (oidc.tf and e2e-broker.tf rely on that), the same pin as infra/aws-oidc.
      version = "~> 5.81"
    }
  }
}
