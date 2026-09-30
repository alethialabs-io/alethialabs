# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "target_subscription_id" {
  description = "Subscription B: owns the Key Vault and the canary secret. Must differ from cluster_subscription_id and share its tenant."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.target_subscription_id))
    error_message = "target_subscription_id must be a subscription GUID."
  }
}

variable "cluster_subscription_id" {
  description = "Subscription A: the one the e2e cluster runs in (infra/azure-e2e). The standing external-secrets identity is created here, next to the cluster."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.cluster_subscription_id))
    error_message = "cluster_subscription_id must be a subscription GUID."
  }
}

variable "location" {
  description = "Region for the vault and the identity. Key Vault is reached over its public endpoint, so this need not match the cluster's region."
  type        = string
  default     = "germanywestcentral"
}

variable "identity_resource_group_name" {
  description = "Resource group in subscription A holding the STANDING external-secrets identity. It must carry no alethia:project-id tag: scripts/e2e/azure-cleanup.sh deletes resource groups by that tag, and this one must outlive every run."
  type        = string
  default     = "alethia-e2e-xacct-identity"
}

variable "identity_name" {
  description = "Name of the STANDING user-assigned identity the e2e cluster adopts through external_secrets_identity_name."
  type        = string
  default     = "alethia-e2e-xacct-eso"
}

variable "vault_resource_group_name" {
  description = "Resource group in subscription B holding the vault."
  type        = string
  default     = "alethia-e2e-xacct-secrets"
}

variable "vault_name_prefix" {
  description = "Key Vault names are globally unique and at most 24 characters; a 6-character random suffix is appended to this."
  type        = string
  default     = "alethia-xacct-"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,16}$", var.vault_name_prefix))
    error_message = "vault_name_prefix must start with a letter, use letters, digits and dashes, and be at most 17 characters (24 with the suffix)."
  }
}

variable "secret_name" {
  description = "Name of the canary secret in the vault. Key Vault allows letters, digits and dashes only."
  type        = string
  default     = "alethia-e2e-xacct-canary"

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]{1,127}$", var.secret_name))
    error_message = "secret_name may contain only letters, digits and dashes."
  }
}

variable "canary_value" {
  description = "The canary's value. Supply via TF_VAR_canary_value (e.g. `openssl rand -hex 24`) — NEVER commit it. Only its sha256 leaves this stack (outputs.tf)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.canary_value) >= 16
    error_message = "canary_value must be at least 16 characters — a short or empty canary makes the e2e's digest comparison satisfiable by an empty read."
  }
}

variable "tags" {
  description = "Tags on every taggable resource. Deliberately no alethia:project-id (see identity_resource_group_name)."
  type        = map(string)
  default = {
    "managed-by" = "alethia-infra"
    "purpose"    = "e2e-xacct-canary"
    "stack"      = "infra/azure-secrets-e2e"
    "issue"      = "1268"
  }
}
