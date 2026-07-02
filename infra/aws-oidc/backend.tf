# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# AWS-native S3 backend in the same account as the IAM it creates. The admin
# identity that applies this bootstrap authenticates the backend natively — no
# static state keys. Configure with `tofu init -backend-config=backend.hcl`.
terraform {
  backend "s3" {}
}
