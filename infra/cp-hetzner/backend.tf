# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# S3-compatible state backend (same convention as infra/platform).
# Configure with `tofu init -backend-config=backend.hcl` (never commit
# backend.hcl — see backend.hcl.example).
terraform {
  backend "s3" {}
}
