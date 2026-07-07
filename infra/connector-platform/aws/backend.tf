# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# AWS-native S3 backend in the same platform account as the IAM it creates. The admin identity that
# applies this authenticates the backend natively — no static state keys. Configure with
# `tofu init -backend-config=backend.hcl`. (Omit the backend for a local-state trial run.)
terraform {
  backend "s3" {}
}
