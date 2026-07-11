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

# Least-privilege: grant external-dns dns.admin on the PROJECT'S managed zone only,
# not project-wide. Project-wide dns.admin forced the provisioner to hold
# resourcemanager.projectIamAdmin (owner-equivalent) to write it; the zone-scoped
# binding needs only dns.admin on the zone the template created. When Cloud DNS
# isn't provisioned there is no zone for external-dns to manage, so no binding.
resource "google_dns_managed_zone_iam_member" "external_dns_dns" {
  count        = var.provision_gke && var.cloud_dns_enabled ? 1 : 0
  project      = var.project_id
  managed_zone = module.cloud_dns[0].zone_name
  role         = "roles/dns.admin"
  member       = "serviceAccount:${google_service_account.external_dns[0].email}"
}

resource "google_service_account_iam_member" "external_dns_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = google_service_account.external_dns[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-dns/external-dns-sa]"
}

# GSA for the external-secrets operator: bound to its KSA via Workload Identity so the
# gcpsm ClusterSecretStore reads Secret Manager with NO static key. Exported as
# `external_secrets_service_account` and rendered onto the operator's ServiceAccount
# (iam.gke.io/gcp-service-account annotation) by the ArgoCD Application.
resource "google_service_account" "external_secrets" {
  count        = var.provision_gke ? 1 : 0
  project      = var.project_id
  account_id   = "extsec-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "external-secrets (${var.project_name})"
}

# Least-privilege: secretAccessor is granted PER SECRET (the ones this template creates via
# modules/secret-manager), not project-wide — a project-level binding would force the
# provisioner to hold resourcemanager.projectIamAdmin (same rationale as the zone-scoped
# external-dns binding above). Keyed by the secret's declared name (known at plan time).
resource "google_secret_manager_secret_iam_member" "external_secrets_accessor" {
  for_each = var.provision_gke ? { for s in var.custom_secrets : s.name => s } : {}

  project   = var.project_id
  secret_id = "${var.environment}-${var.project_name}-${each.key}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.external_secrets[0].email}"

  depends_on = [module.secret_manager]
}

resource "google_service_account_iam_member" "external_secrets_wi" {
  count              = var.provision_gke ? 1 : 0
  service_account_id = google_service_account.external_secrets[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[external-secrets-operator/external-secrets-operator-sa]"
}
