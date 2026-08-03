# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-project GAR (Artifact Registry) pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Cross-project GAR pull (PR B): when gar-xacct is selected the cluster-side pull GSA must exist (the
# refresher's Workload-Identity impersonation target). A missing GSA means the refresher can't mint.
#
# Keyed on `gar_pull_requested` and naming `provision_gke` explicitly, exactly as
# checks_data.tf's keyless_cloud_sql_app_identity_wired does. Keying it on `enable_gar_pull` — which
# gained the cluster term — would make the check judge its own definition and go silent on precisely
# the shape it should report: gar-xacct selected with no cluster to run the refresher in.
check "gar_pull_xacct_identity_present" {
  assert {
    condition     = !local.gar_pull_requested || (var.provision_gke && length(google_service_account.gar_pull) == 1)
    error_message = "registry_pull_provider = gar-xacct but the cross-project GAR pull identity is incomplete: it needs provision_gke=true (the refresher runs in-cluster and impersonates the GSA via Workload Identity) and the pull service account."
  }
}
