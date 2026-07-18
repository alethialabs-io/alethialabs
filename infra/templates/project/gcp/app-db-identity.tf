#########################################################################
##        Keyless app→Cloud SQL identity (Workload Identity)  #722      ##
#########################################################################
# When Cloud SQL has IAM authentication enabled, the app workload connects to it KEYLESSLY:
# a dedicated Google service account is bound (via GKE Workload Identity) to the in-cluster
# app KSA, granted least-privilege Cloud SQL access, and registered as a CLOUD_IAM_SERVICE_ACCOUNT
# database user (see modules/cloud-sql). The app pod runs the Cloud SQL Auth Proxy sidecar
# (--auto-iam-authn), which mints a short-lived IAM token from this identity — the workload holds
# NO database password. This mirrors the external-dns / external-secrets Workload Identity pattern.
#
# The KSA the app runs as is created + annotated by the generated GitOps manifests (the keyless
# manifest lane, #722): namespace/name below MUST match `manifests` keylessKSANamespace/keylessKSAName.

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessKSANamespace).
  app_ksa_namespace = "default"
  app_ksa_name      = "alethia-app"
  enable_app_db_iam = var.create_cloud_sql && var.cloud_sql_iam_auth
}

resource "google_service_account" "app_db" {
  count        = local.enable_app_db_iam ? 1 : 0
  project      = var.project_id
  account_id   = "appdb-${substr(sha256(local.gke_name), 0, 8)}"
  display_name = "app Cloud SQL (${var.project_name})"
}

# Least-privilege: cloudsql.client (connect through the proxy) + cloudsql.instanceUser (IAM login).
# Deliberately NOT cloudsql.admin / instanceAdmin — the app only needs to CONNECT, never manage.
resource "google_project_iam_member" "app_db_client" {
  count   = local.enable_app_db_iam ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.app_db[0].email}"
}

resource "google_project_iam_member" "app_db_instance_user" {
  count   = local.enable_app_db_iam ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.app_db[0].email}"
}

# Bind the GSA to the app KSA via Workload Identity, so a pod running as that KSA impersonates the
# GSA with no static key. `member` names the WI pool as a STRING, so the dependency on the cluster
# must be explicit (same race as external_dns_wi — Identity Pool does not exist otherwise).
resource "google_service_account_iam_member" "app_db_wi" {
  count              = local.enable_app_db_iam ? 1 : 0
  service_account_id = google_service_account.app_db[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.app_ksa_namespace}/${local.app_ksa_name}]"

  depends_on = [module.gke]
}
