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
    # GKE application-layer Secrets encryption (#2092) creates a KMS key ring + key. Without this
    # the first real apply died with `Error 403: Cloud Key Management Service (KMS) API has not
    # been used in project … before or it is disabled` (#2262) — the feature is on by default, so
    # every GKE project needs the API on. It sits here, up-front, for the reason the comment above
    # gives: the least-privileged provisioner has no serviceUsageAdmin and cannot turn an API on
    # mid-apply.
    "cloudkms.googleapis.com",
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
# The one grant that CANNOT be written resource-scoped is the keyless Cloud SQL app identity's —
# see google_service_account.alethia_app_db below — so it is made HERE, once, by you, instead.
# secretmanager.admin is KEPT predefined on purpose: dropping secretmanager.versions.access breaks the
# google provider's secret-version refresh (AccessSecretVersion on read) — tighten only with a real-apply.
#
# cloudkms.admin is category (1) by the rule above, and #2269 is why it is here at all. #2092 turned
# Kubernetes Secrets envelope encryption ON BY DEFAULT (infra/templates/project/gcp/secrets-encryption.tf):
# every new GKE cluster now creates a key ring, a crypto key, and one cryptoKeyEncrypterDecrypter
# binding for the GKE service agent. #2269 gave the API to this connector but no KMS ROLE, so a real
# customer passes the GCP-KMS-ENC-001 plan guard and then 403s at google_kms_key_ring — the same
# shape #2269 closed for Azure and Alibaba, still open on GCP.
#
# It carries no data-plane access by Google's own split: cryptoKeys.useToEncrypt/useToDecrypt live in
# roles/cloudkms.cryptoKeyEncrypterDecrypter, which this provisioner never holds — it WRITES that
# binding for the GKE agent and cannot use the key itself. What it does carry that a narrower custom
# role would omit is cryptoKeyVersions.destroy, and destroying this key makes every etcd backup
# unreadable forever (see the lifecycle block on google_kms_crypto_key.gke_secrets). Tightening to a
# management-only custom role is worth doing — and, exactly like secretmanager.admin above, needs a
# real apply to prove the enumeration is complete before it ships.
resource "google_project_iam_member" "alethia_provisioner" {
  for_each = toset([
    "roles/container.admin",                 # GKE clusters + node pools (churns per release — keep)
    "roles/compute.networkAdmin",            # VPC, subnets, router, NAT, global addresses
    "roles/compute.securityAdmin",           # firewall rules, Cloud Armor, SSL certs
    "roles/servicenetworking.networksAdmin", # private-services peering (Cloud SQL / Memorystore)
    "roles/cloudsql.admin",                  # Cloud SQL
    "roles/redis.admin",                     # Memorystore
    "roles/dns.admin",                       # Cloud DNS managed zones — NOT setIamPolicy, see dns_zone_iam below
    "roles/artifactregistry.admin",          # Artifact Registry
    "roles/secretmanager.admin",             # Secret Manager (kept — see note re: versions.access)
    "roles/cloudkms.admin",                  # CMK for GKE Secrets encryption (#2092, on by default)
    "roles/iam.serviceAccountUser",          # actAs the node/add-on SAs
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.alethia.email}"
}

# ── Keyless Cloud SQL app identity ─────────────────────────────────────────────────────────────
# The account your APPLICATION workloads impersonate to reach Cloud SQL without a password. It is
# created and granted HERE, by you, rather than by the Alethia provisioner — and that split is
# forced, not stylistic:
#
#   `roles/cloudsql.client` and `roles/cloudsql.instanceUser` can only be granted at PROJECT scope. A
#   Cloud SQL instance is not IAM-policy-bearing (the Admin API exposes no get/setIamPolicy on
#   instances, and no google_sql_database_instance_iam_member exists), so the zone-scoped and
#   per-secret trick used everywhere else has no Cloud SQL analogue. Writing a project binding needs
#   resourcemanager.projects.setIamPolicy — owner-equivalent, and the whole point of the note above
#   is that the provisioner does not hold it. Granting it so the provisioner could write these two
#   bindings would hand it the ability to grant itself anything.
#
#   GCP also has no principal-pattern IAM condition (no aws:PrincipalArn analogue), so the grant
#   cannot be pre-written against a per-deployment identity either. A stable account, granted once,
#   is the only shape left.
#
# TRADE-OFF worth knowing before you apply: this is ONE account for the whole project, so every
# Alethia environment in it shares this database identity — an app in one environment could log in
# to another environment's instance. What each may DO inside a database is still scoped by the SQL
# GRANTs Alethia issues per database. If you need environments isolated at the identity level, run
# them in separate Google Cloud projects.
#
# Pass the email this outputs (`cloud_sql_app_service_account_email`) to Alethia to turn keyless
# Cloud SQL auth on. Leave it unset and your apps simply keep using password authentication.
resource "google_service_account" "alethia_app_db" {
  account_id   = "alethia-appdb"
  display_name = "Alethia app → Cloud SQL (keyless)"
  description  = "Impersonated by Alethia app workloads via GKE Workload Identity to log in to Cloud SQL with an IAM token instead of a password"

  depends_on = [google_project_service.apis]
}

# Least-privilege: cloudsql.client (connect through the Auth Proxy) + cloudsql.instanceUser (IAM
# login). Deliberately NOT cloudsql.admin / instanceAdmin — the app only ever CONNECTS, never
# manages. Neither role carries setIamPolicy, so this account cannot escalate.
resource "google_project_iam_member" "alethia_app_db" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.alethia_app_db.email}"
}

# ── Custom roles: management-only replacements for the data-plane-broad predefined admin roles. ──
# The one DNS permission roles/dns.admin does not carry.
#
# The gcp project template creates a ZONE-SCOPED binding so external-dns (and cert-manager's DNS01
# solver, which shares the identity) can write records into the zone —
# infra/templates/project/gcp/workload-identity.tf, google_dns_managed_zone_iam_member. Writing that
# binding needs `dns.managedZones.setIamPolicy`, and MEASURED against the live API:
#
#   roles/dns.admin  → dns.managedZones.getIamPolicy   ✓   setIamPolicy ✗
#   roles/editor     → setIamPolicy ✗
#   roles/dns.peer   → setIamPolicy ✗
#   roles/owner      → setIamPolicy ✓
#
# So among predefined roles ONLY owner can create it — which a least-privilege connector must never
# be. The list above claimed dns.admin covered it ("+ zone-scoped setIamPolicy"); it never did, and
# the comment is corrected alongside this role.
#
# The cost of the gap was silent in exactly the way that hurts: every plan stayed green, and the
# apply failed at
#
#   Error setting IAM policy for dns managedzone "...": Error 403: The caller does not have
#   permission, forbidden
#
# on gcp's first full bar (32840106190). A floor run never reaches it, because the floor provisions
# no DNS zone.
#
# `dns.managedZones.setIamPolicy` is SUPPORTED in custom roles (gcloud list-testable-permissions
# reports no support-level restriction), so this stays scoped to one permission rather than
# reaching for owner. getIamPolicy rides along so a plan can READ the binding it is about to write;
# dns.admin already grants it, and restating it here keeps the role self-contained if the predefined
# grant is ever narrowed.
resource "google_project_iam_custom_role" "dns_zone_iam" {
  role_id     = "alethiaDnsZoneIam"
  project     = var.project_id
  title       = "Alethia DNS Zone IAM Binder"
  description = "Set/get IAM policy on Cloud DNS managed zones — the zone-scoped external-dns binding. roles/dns.admin does NOT include setIamPolicy; only roles/owner does."
  permissions = [
    "dns.managedZones.getIamPolicy",
    "dns.managedZones.setIamPolicy",
  ]
}

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
  description = "Read project metadata and service-enablement state (replaces roles/browser; no folder/org hierarchy reads)."
  # `serviceusage.services.get` is a READ, and the distinction is the whole point (#1844). Artifact
  # Registry's per-repository scanning enum is INHERITED | DISABLED with no ENABLED, so the ON
  # position only means anything when `containerscanning.googleapis.com` is enabled on the project.
  # The template refuses that switch when the API is absent — which it can only do if it can SEE the
  # answer.
  #
  # `serviceusage.services.enable` was refused (maintainer, 2026-08-03) and stays refused: it would
  # let the provisioner turn on ANY API in the customer's project, including billable ones nobody
  # asked for, and there is no narrower form of that verb. `get` has one: it reads a boolean about a
  # service the customer already chose. Enabling the API remains an onboarding step the CUSTOMER
  # performs.
  permissions = [
    "resourcemanager.projects.get",
    "serviceusage.services.get",
  ]
}

resource "google_project_iam_member" "alethia_provisioner_custom" {
  for_each = toset([
    google_project_iam_custom_role.storage_provisioner.id,
    google_project_iam_custom_role.firestore_provisioner.id,
    google_project_iam_custom_role.pubsub_provisioner.id,
    google_project_iam_custom_role.sa_provisioner.id,
    google_project_iam_custom_role.project_reader.id,
    google_project_iam_custom_role.dns_zone_iam.id,
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

output "cloud_sql_app_service_account_email" {
  description = "Keyless Cloud SQL app identity — set this as `cloud_sql_app_service_account_email` in Alethia to turn on password-free Cloud SQL auth. Leave it unset there and your apps keep using password authentication."
  value       = google_service_account.alethia_app_db.email
}

output "project_number" {
  value = data.google_project.current.number
}
