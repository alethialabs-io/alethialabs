# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# AWS-native S3 state backend, in the shared bucket aws-oidc and infra/e2e-issuer already use. The
# maintainer applying this stack authenticates it with their own AWS credentials — no static keys.
# Configure with `tofu init -backend-config=backend.hcl` (see backend.hcl.example).
terraform {
  backend "s3" {}
}
