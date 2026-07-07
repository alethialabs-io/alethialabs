# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# S3-compatible state backend (configure via `tofu init -backend-config=backend.hcl`).
terraform {
  backend "s3" {}
}
