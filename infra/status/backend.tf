# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# S3-compatible state backend (same convention as infra/hetzner + infra/platform).
# Configure with `terraform init -backend-config=backend.hcl` (never commit
# backend.hcl — see backend.hcl.example). For a one-off box you may instead delete
# this file to use local state.
terraform {
  backend "s3" {}
}
