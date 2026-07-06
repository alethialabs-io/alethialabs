# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# Auth via a GitHub App installation token (minted per-run by the bootstrap
# workflow → TF_VAR_github_token). owner/repo are variables so moving to an org
# repo later is a var change, not an edit.
provider "github" {
  owner = var.github_owner
  token = var.github_token
}
