# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

provider "google" {
  project = var.project_id
  region  = var.region
}

# Read-back of the target project (its NUMBER anchors the WIF principalSet member and scopes the
# billing budget to exactly this project).
data "google_project" "this" {
  project_id = var.project_id
}
