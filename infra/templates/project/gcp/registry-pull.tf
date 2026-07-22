# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-project KEYLESS Artifact Registry pull identity (PR B). When a project selects the `gar-xacct`
# registry, the in-cluster refresher (default/alethia-registry-pull) mints a GCP OAuth token via this
# GSA (bound through GKE Workload Identity) and pulls from the TARGET project's Artifact Registry — no
# stored key. The pull works cross-project because the target project granted this GSA
# roles/artifactregistry.reader (the "trust bootstrap" — target-side, see the PR B design doc). Cluster-
# side we only create the GSA + the WI binding + expose its email; it rides `registry_pull_provider`,
# so the cluster's native Artifact Registry is untouched.

locals {
  enable_gar_pull = var.registry_pull_provider == "gar-xacct"
  # Coupling point with packages/core/manifests (the registry-pull refresher KSA the wiring PR emits).
  registry_pull_ksa_namespace = "default"
  registry_pull_ksa_name      = "alethia-registry-pull"
}

resource "google_service_account" "gar_pull" {
  count        = local.enable_gar_pull ? 1 : 0
  project      = var.project_id
  account_id   = "garpull-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "cross-project GAR pull (${var.project_name})"
}

# Bind the GSA to the refresher KSA via Workload Identity — a pod running as that KSA impersonates the
# GSA with no static key. The target-project reader grant is applied by the customer (target-side).
resource "google_service_account_iam_member" "gar_pull_wi" {
  count              = local.enable_gar_pull ? 1 : 0
  service_account_id = google_service_account.gar_pull[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.registry_pull_ksa_namespace}/${local.registry_pull_ksa_name}]"

  depends_on = [module.gke]
}

output "gar_pull_gsa_email" {
  description = "Email of the cross-project GAR pull GSA annotating the refresher KSA (empty unless gar-xacct). The customer grants this artifactregistry.reader on the target project."
  value       = try(google_service_account.gar_pull[0].email, "")
}
