variable "project_id" {
  description = "GCP project ID where Grape will provision resources"
  type        = string
}

variable "grape_aws_account_id" {
  description = "Grape platform AWS account ID"
  type        = string
  default     = "787587782604"
}

variable "pool_id" {
  description = "Workload Identity Pool ID"
  type        = string
  default     = "grape-pool"
}

variable "provider_id" {
  description = "Workload Identity Provider ID"
  type        = string
  default     = "grape-aws-provider"
}

variable "service_account_name" {
  description = "Service account name for Grape"
  type        = string
  default     = "grape-provisioner"
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

resource "google_service_account" "grape" {
  account_id   = var.service_account_name
  display_name = "Grape Provisioner"
  description  = "Used by Grape to provision GKE clusters and Google Cloud resources"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "grape_editor" {
  project = var.project_id
  role    = "roles/editor"
  member  = "serviceAccount:${google_service_account.grape.email}"
}

resource "google_iam_workload_identity_pool" "grape" {
  workload_identity_pool_id = var.pool_id
  display_name              = "Grape Identity Pool"
  description               = "Allows Grape workers to authenticate from AWS"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "grape_aws" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.grape.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "Grape AWS Provider"

  aws {
    account_id = var.grape_aws_account_id
  }
}

resource "google_service_account_iam_member" "wif_binding" {
  service_account_id = google_service_account.grape.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.grape.name}/*"
}

output "credential_config" {
  description = "WIF credential configuration JSON — paste this into the Grape dashboard"
  sensitive   = false
  value = jsonencode({
    type                              = "external_account"
    audience                          = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.grape_aws.name}"
    subject_token_type                = "urn:ietf:params:aws:token-type:aws4_request"
    token_url                         = "https://sts.googleapis.com/v1/token"
    service_account_impersonation_url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${google_service_account.grape.email}:generateAccessToken"
    credential_source = {
      environment_id                = "aws1"
      region_url                    = "http://169.254.169.254/latest/meta-data/placement/availability-zone"
      url                           = "http://169.254.169.254/latest/meta-data/iam/security-credentials"
      regional_cred_verification_url = "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
    }
  })
}

output "service_account_email" {
  value = google_service_account.grape.email
}

output "project_number" {
  value = data.google_project.current.number
}
