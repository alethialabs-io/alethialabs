# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-project GAR (Artifact Registry) pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Cross-project GAR pull (PR B): when gar-xacct is selected the cluster-side pull GSA must exist (the
# refresher's Workload-Identity impersonation target). A missing GSA means the refresher can't mint.
check "gar_pull_xacct_identity_present" {
  assert {
    condition     = !local.enable_gar_pull || length(google_service_account.gar_pull) == 1
    error_message = "registry_pull_provider = gar-xacct but the cross-project GAR pull service account was not created."
  }
}
