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

resource "google_project_iam_member" "alethia_editor" {
  project = var.project_id
  role    = "roles/editor"
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
