variable "project_id" {
  description = "GCP project ID where Vertex will provision resources"
  type        = string
}

variable "vertex_aws_account_id" {
  description = "Vertex platform AWS account ID"
  type        = string
  default     = "787587782604"
}

variable "pool_id" {
  description = "Workload Identity Pool ID"
  type        = string
  default     = "vertex-pool"
}

variable "provider_id" {
  description = "Workload Identity Provider ID"
  type        = string
  default     = "vertex-aws-provider"
}

variable "service_account_name" {
  description = "Service account name for Vertex"
  type        = string
  default     = "vertex-provisioner"
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

locals {
  sa_email = "${var.service_account_name}@${var.project_id}.iam.gserviceaccount.com"
}

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

resource "google_service_account" "vertex" {
  account_id   = var.service_account_name
  display_name = "Vertex Provisioner"
  description  = "Used by Vertex to provision GKE clusters and Google Cloud resources"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "vertex_editor" {
  project = var.project_id
  role    = "roles/editor"
  member  = "serviceAccount:${google_service_account.vertex.email}"
}

resource "google_iam_workload_identity_pool" "vertex" {
  workload_identity_pool_id = var.pool_id
  display_name              = "Vertex Identity Pool"
  description               = "Allows Vertex workers to authenticate from AWS"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "vertex_aws" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.vertex.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "Vertex AWS Provider"

  aws {
    account_id = var.vertex_aws_account_id
  }
}

resource "google_service_account_iam_member" "wif_binding" {
  service_account_id = google_service_account.vertex.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.vertex.name}/*"
}

output "credential_config" {
  description = "WIF credential configuration JSON — paste this into the Vertex dashboard"
  sensitive   = false
  value = jsonencode({
    type                              = "external_account"
    audience                          = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.vertex_aws.name}"
    subject_token_type                = "urn:ietf:params:aws:token-type:aws4_request"
    token_url                         = "https://sts.googleapis.com/v1/token"
    service_account_impersonation_url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${google_service_account.vertex.email}:generateAccessToken"
    credential_source = {
      environment_id                = "aws1"
      region_url                    = "http://169.254.169.254/latest/meta-data/placement/availability-zone"
      url                           = "http://169.254.169.254/latest/meta-data/iam/security-credentials"
      regional_cred_verification_url = "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
    }
  })
}

output "service_account_email" {
  value = google_service_account.vertex.email
}

output "project_number" {
  value = data.google_project.current.number
}
