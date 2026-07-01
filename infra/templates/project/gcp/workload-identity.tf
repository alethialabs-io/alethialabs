#########################################################################
##            Workload Identity for cluster add-ons                    ##
#########################################################################
# Binds a Google service account to the in-cluster external-dns KSA via GKE
# Workload Identity, so external-dns manages Cloud DNS with NO static key.
# The GSA email is exported as `external_dns_service_account` and rendered onto
# the external-dns ServiceAccount by the ArgoCD Application
# (iam.gke.io/gcp-service-account annotation). This is the GCP analogue of the
# AWS IRSA role the EKS path uses.

resource "google_service_account" "external_dns" {
  count        = var.provision_gke ? 1 : 0
  project      = var.project_id
  account_id   = "extdns-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "external-dns (${var.project_name})"
}

resource "google_project_iam_member" "external_dns_admin" {
  count   = var.provision_gke ? 1 : 0
  project = var.project_id
  role    = "roles/dns.admin"
  member  = "serviceAccount:${google_service_account.external_dns[0].email}"
}

resource "google_service_account_iam_member" "external_dns_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = google_service_account.external_dns[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-dns/external-dns-sa]"
}
