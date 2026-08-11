# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "target_project_id" {
  description = "The GCP project that OWNS the secrets (project B — where this stack is applied). The e2e cluster lives in a different project."
  type        = string
}

variable "cluster_project_id" {
  description = "The project the Alethia e2e cluster runs in (project A). Recorded so checks.tf can refuse a same-project apply, which would prove nothing about crossing a boundary."
  type        = string
}

variable "cluster_external_secrets_sa" {
  description = "The STANDING external-secrets Google service account email that the project template adopts via external_secrets_service_account_email. Granted secretAccessor on the canary below. It must outlive the cluster: GCP rewrites a deleted SA's binding to `deleted:serviceAccount:...?uid=`, and a same-named recreation does not inherit it."
  type        = string

  validation {
    condition     = can(regex("^[^@]+@[^.]+\\.iam\\.gserviceaccount\\.com$", var.cluster_external_secrets_sa))
    error_message = "cluster_external_secrets_sa must be a GSA email (name@project.iam.gserviceaccount.com)."
  }
}

variable "secret_name" {
  description = "Secret id for the canary in project B."
  type        = string
  default     = "alethia-e2e-xacct-canary"
}

variable "canary_value" {
  description = "The canary's value. Supply via TF_VAR_canary_value — NEVER commit it. Only its sha256 leaves this stack (see outputs.tf)."
  type        = string
  sensitive   = true
}

variable "labels" {
  description = "Labels applied to the canary secret."
  type        = map(string)
  default     = { managed-by = "alethia-infra", purpose = "e2e-xacct-canary" }
}
