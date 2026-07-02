# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# AWS-native S3 backend (shared state bucket). The bootstrap workflow already has
# AWS creds (admin, for aws-oidc) in scope, so the backend authenticates natively.
terraform {
  backend "s3" {}
}
