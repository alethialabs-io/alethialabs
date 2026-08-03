# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

provider "google" {
  project = var.project_id
  region  = var.region

  # billingbudgets.googleapis.com is a per-USER-project quota API: under Application Default
  # Credentials it bills the request to the caller's quota project, which for a human's ADC is
  # Google's shared default (projects/764086051850) rather than this one — so the apply fails with
  # SERVICE_DISABLED naming a project nobody owns. `gcloud auth application-default
  # set-quota-project` alone does NOT fix it; the provider has to be told to attribute the request.
  user_project_override = true
  billing_project       = var.project_id
}

# Read-back of the target project (its NUMBER anchors the WIF principalSet member and scopes the
# billing budget to exactly this project).
data "google_project" "this" {
  project_id = var.project_id
}
