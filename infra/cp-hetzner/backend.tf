# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# AWS-native S3 state backend. In CI the apply job assumes the alethia-cp-deployer
# OIDC role (infra/aws-oidc), which authenticates this backend — no static keys.
# Configure with `tofu init -backend-config=backend.hcl` (see backend.hcl.example).
terraform {
  backend "s3" {}
}
