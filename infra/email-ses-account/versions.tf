# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  # >= 1.10 for the S3 backend's native `use_lockfile` (no DynamoDB lock table), as infra/aws-e2e.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # The same pin as infra/aws-e2e. identity.tf reads the existing domain identity through the
      # `aws_sesv2_email_identity` DATA source, which every 5.81+ release carries.
      version = "~> 5.81"
    }
  }
}
