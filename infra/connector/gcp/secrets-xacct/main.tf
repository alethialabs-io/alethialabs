# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-project keyless GCP Secret Manager — TARGET-project read grant (Model B).
#
# You run this in the project that OWNS the secrets (project B), ONCE. It grants your Alethia cluster's
# external-secrets Workload-Identity service account read access to the named secrets — no service
# account key is created or stored. The in-cluster External Secrets Operator authenticates with the
# cluster's Workload Identity and reads project B directly (ESO `gcpsm.projectID`). Enter the target
# project id in the Alethia `gcp-sm-xacct` connector.
#
# Prereqs: OpenTofu/Terraform authenticated to the SECRETS project (B); the cluster's external-secrets
# GSA email (the `gcp-sm-xacct` connector shows it, or read the project's
# `external_secrets_service_account` output).

variable "cluster_external_secrets_sa" {
  description = "The Alethia cluster's external-secrets Google service account email (from the project's external_secrets_service_account output). Granted secretAccessor on the target secrets below."
  type        = string

  validation {
    condition     = can(regex("^[^@]+@[^.]+\\.iam\\.gserviceaccount\\.com$", var.cluster_external_secrets_sa))
    error_message = "cluster_external_secrets_sa must be a GSA email (name@project.iam.gserviceaccount.com)."
  }
}

variable "target_project_id" {
  description = "The GCP project that owns the secrets (where this grant is applied)."
  type        = string
}

variable "secret_ids" {
  description = "Secret Manager secret ids (short names) in the target project to grant read on. SCOPE this to exactly the secrets you share (least-privilege) — a per-secret grant, not a project-wide one."
  type        = list(string)

  validation {
    condition     = length(var.secret_ids) > 0
    error_message = "Name at least one secret id — grant read per-secret rather than project-wide."
  }
}

# roles/secretmanager.secretAccessor on EACH named secret only — least-privilege, never project-wide.
resource "google_secret_manager_secret_iam_member" "reader" {
  for_each = toset(var.secret_ids)

  project   = var.target_project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.cluster_external_secrets_sa}"
}

output "granted_secrets" {
  value       = var.secret_ids
  description = "The secrets the cluster's external-secrets identity may now read in the target project."
}
