# Alethia GCP connector — keyless, DIRECT OIDC federation from the Alethia issuer (no AWS hop).
# Registers a Workload Identity Pool with an OIDC provider that trusts Alethia's control-plane issuer,
# pinned to the fixed workload subject + audience the console mints, and a provisioner service account.
# Alethia authenticates with a short-lived minted JWT written to a token file that google-auth re-reads —
# no service-account key, no static credential. Paste the `credential_config` output into the connect sheet.
# Kept in parity with the served customer module apps/console/public/connector-terraform/gcp.tf.

variable "project_id" {
  description = "GCP project ID where Alethia will provision resources"
  type        = string
}

variable "alethia_issuer_url" {
  description = "The Alethia control-plane OIDC issuer URL (the trust root)."
  type        = string
  default     = "https://alethialabs.io/api/oidc"
}

variable "gcp_audience" {
  description = "The audience the OIDC provider pins — must equal GCP_TOKEN_AUDIENCE (session/gcp.ts)."
  type        = string
  default     = "alethia-gcp-wif"
}

variable "pool_id" {
  description = "Workload Identity Pool ID"
  type        = string
  default     = "alethia-pool"
}

variable "provider_id" {
  description = "Workload Identity Provider ID"
  type        = string
  default     = "alethia-oidc-provider"
}

variable "service_account_name" {
  description = "Service account name for Alethia"
  type        = string
  default     = "alethia-provisioner"
}

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
}

data "google_project" "current" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "iam.googleapis.com",
    "sts.googleapis.com",
    "iamcredentials.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "dns.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    # Enabled up-front so the least-privileged provisioner (no serviceUsageAdmin)
    # never has to turn an API on mid-apply — the audit's most-likely silent breakage.
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "servicenetworking.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "alethia" {
  account_id   = var.service_account_name
  display_name = "Alethia Provisioner"
  description  = "Used by Alethia to provision GKE clusters and Google Cloud resources"

  depends_on = [google_project_service.apis]
}

# Least-privilege. Two kinds of grant:
#   (1) Predefined roles for services whose Google-maintained admin set is already tightly scoped and
#       churns with new features (GKE especially) — hand-enumerating those into custom roles is a
#       maintenance trap and buys nothing (they carry no cross-service or data-exfil surface).
#   (2) CUSTOM roles for the services whose predefined admin role bundles DATA-PLANE access a
#       provisioner must never hold — GCS object data, Firestore document data, Pub/Sub message
#       publish/consume, and the org/folder hierarchy reads of roles/browser. The custom roles below
#       grant management verbs only (create/delete/get/list/update/[set]IamPolicy).
# NOTE: the templates use resource-level IAM bindings (zone-scoped external-dns; per-secret accessor;
# per-GSA workloadIdentityUser), so the provisioner needs NO resourcemanager.projectIamAdmin.
# secretmanager.admin is KEPT predefined on purpose: dropping secretmanager.versions.access breaks the
# google provider's secret-version refresh (AccessSecretVersion on read) — tighten only with a real-apply.
resource "google_project_iam_member" "alethia_provisioner" {
  for_each = toset([
    "roles/container.admin",                 # GKE clusters + node pools (churns per release — keep)
    "roles/compute.networkAdmin",            # VPC, subnets, router, NAT, global addresses
    "roles/compute.securityAdmin",           # firewall rules, Cloud Armor, SSL certs
    "roles/servicenetworking.networksAdmin", # private-services peering (Cloud SQL / Memorystore)
    "roles/cloudsql.admin",                  # Cloud SQL
    "roles/redis.admin",                     # Memorystore
    "roles/dns.admin",                       # Cloud DNS managed zones (+ zone-scoped setIamPolicy)
    "roles/artifactregistry.admin",          # Artifact Registry
    "roles/secretmanager.admin",             # Secret Manager (kept — see note re: versions.access)
    "roles/iam.serviceAccountUser",          # actAs the node/add-on SAs
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.alethia.email}"
}

# ── Custom roles: management-only replacements for the data-plane-broad predefined admin roles. ──
resource "google_project_iam_custom_role" "storage_provisioner" {
  role_id     = "alethiaStorageProvisioner"
  project     = var.project_id
  title       = "Alethia Storage Bucket Provisioner"
  description = "Create/manage GCS buckets + bucket IAM; NO object data access (replaces roles/storage.admin)."
  permissions = [
    "storage.buckets.create", "storage.buckets.delete", "storage.buckets.get",
    "storage.buckets.list", "storage.buckets.update",
    "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy",
  ]
}

resource "google_project_iam_custom_role" "firestore_provisioner" {
  role_id     = "alethiaFirestoreProvisioner"
  project     = var.project_id
  title       = "Alethia Firestore Provisioner"
  description = "Create/manage Firestore databases + indexes; NO entity data access (replaces roles/datastore.owner)."
  permissions = [
    "datastore.databases.create", "datastore.databases.delete", "datastore.databases.get",
    "datastore.databases.getMetadata", "datastore.databases.list", "datastore.databases.update",
    "datastore.indexes.create", "datastore.indexes.delete", "datastore.indexes.get",
    "datastore.indexes.list", "datastore.indexes.update",
    "datastore.operations.get", "datastore.operations.list",
  ]
}

resource "google_project_iam_custom_role" "pubsub_provisioner" {
  role_id     = "alethiaPubSubProvisioner"
  project     = var.project_id
  title       = "Alethia Pub/Sub Provisioner"
  description = "Create/manage topics + subscriptions; NO publish/consume (replaces roles/pubsub.admin)."
  permissions = [
    "pubsub.topics.create", "pubsub.topics.delete", "pubsub.topics.get",
    "pubsub.topics.list", "pubsub.topics.update", "pubsub.topics.attachSubscription",
    "pubsub.subscriptions.create", "pubsub.subscriptions.delete", "pubsub.subscriptions.get",
    "pubsub.subscriptions.list", "pubsub.subscriptions.update",
  ]
}

resource "google_project_iam_custom_role" "sa_provisioner" {
  role_id     = "alethiaServiceAccountProvisioner"
  project     = var.project_id
  title       = "Alethia Add-on SA Provisioner"
  description = "Create/manage the add-on GSAs (external-dns/external-secrets) + their IAM (replaces roles/iam.serviceAccountAdmin; drops undelete/enable/disable)."
  permissions = [
    "iam.serviceAccounts.create", "iam.serviceAccounts.delete", "iam.serviceAccounts.get",
    "iam.serviceAccounts.list", "iam.serviceAccounts.update",
    "iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy",
  ]
}

resource "google_project_iam_custom_role" "project_reader" {
  role_id     = "alethiaProjectReader"
  project     = var.project_id
  title       = "Alethia Project Reader"
  description = "Read project metadata for data.google_project (replaces roles/browser; no folder/org hierarchy reads)."
  permissions = ["resourcemanager.projects.get"]
}

resource "google_project_iam_member" "alethia_provisioner_custom" {
  for_each = toset([
    google_project_iam_custom_role.storage_provisioner.id,
    google_project_iam_custom_role.firestore_provisioner.id,
    google_project_iam_custom_role.pubsub_provisioner.id,
    google_project_iam_custom_role.sa_provisioner.id,
    google_project_iam_custom_role.project_reader.id,
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.alethia.email}"
}

resource "google_iam_workload_identity_pool" "alethia" {
  workload_identity_pool_id = var.pool_id
  display_name              = "Alethia Identity Pool"
  description               = "Trusts the Alethia OIDC issuer for keyless federation"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "alethia_oidc" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.alethia.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "Alethia OIDC Provider"

  # Map the minted JWT's `sub` to the GCP subject — the SA binding below pins it to "alethia-connector".
  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }

  oidc {
    issuer_uri        = var.alethia_issuer_url
    allowed_audiences = [var.gcp_audience]
  }
}

# Bind ONLY the fixed workload subject (not the whole pool) to the provisioner SA.
resource "google_service_account_iam_member" "wif_binding" {
  service_account_id = google_service_account.alethia.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.alethia.name}/subject/alethia-connector"
}

output "credential_config" {
  description = "WIF credential configuration JSON — paste this into the Alethia connect sheet"
  sensitive   = false
  value = jsonencode({
    type                              = "external_account"
    audience                          = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.alethia_oidc.name}"
    subject_token_type                = "urn:ietf:params:oauth:token-type:jwt"
    token_url                         = "https://sts.googleapis.com/v1/token"
    service_account_impersonation_url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${google_service_account.alethia.email}:generateAccessToken"
    # Alethia's runner overrides `file` with its own temp path at provision time; the console supplies
    # the token programmatically. The placeholder just makes the config a valid external_account.
    credential_source = {
      file   = "/var/run/alethia/gcp-oidc-token"
      format = { type = "text" }
    }
  })
}

output "service_account_email" {
  value = google_service_account.alethia.email
}

output "project_number" {
  value = data.google_project.current.number
}
