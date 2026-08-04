# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# The maintainer applies this with an admin identity (gcloud ADC). Nothing here is a per-user-project
# quota API, so — unlike the parent stack's billing-budgets provider — no `user_project_override` is
# needed.
provider "google" {
  project = var.project_id
  region  = var.region
}
