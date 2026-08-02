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
  # What the OPERATOR ASKED FOR, cluster-independent — this is what checks_registry.tf judges, so the
  # misconfiguration warning stays armed on a cluster-less shape.
  gar_pull_requested = var.registry_pull_provider == "gar-xacct"

  # What gets BUILT additionally needs the cluster. This GSA exists solely to be impersonated through
  # GKE WORKLOAD IDENTITY by the in-cluster refresher KSA, and the WI pool (<project>.svc.id.goog) is
  # created BY the cluster. Without `provision_gke` this is AWS #1772 in its quieter form: `member`
  # below names the pool as a STRING rather than an index, so instead of dying at plan the way AWS
  # did, it planned clean and died at APPLY —
  #   Error 400: Identity Pool does not exist (<project>.svc.id.goog)
  # — the exact failure workload-identity.tf already records from a real apply. Azure's
  # registry-pull.tf carries `&& var.provision_aks` and AWS's now carries `var.provision_eks`; this
  # is the GCP parity. Worth fixing in the same pass precisely because it fails LATER: a plan-time
  # crash is found by CI, an apply-time one is found by a customer.
  enable_gar_pull = var.provision_gke && local.gar_pull_requested
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
