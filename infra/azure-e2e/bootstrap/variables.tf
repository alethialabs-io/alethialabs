# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "subscription_id" {
  description = "The DEDICATED e2e Azure subscription. MUST be the same subscription_id the parent infra/azure-e2e stack is applied into — the state then sits inside the same blast radius as the identity it describes."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "location" {
  description = "Azure region for the state resource group + storage account."
  type        = string
  default     = "germanywestcentral"
}

variable "state_resource_group_name" {
  description = "Resource group holding the state storage account. Matches `resource_group_name` in backend.hcl."
  type        = string
  default     = "alethia-tfstate"
}

variable "state_storage_account_name" {
  description = "Storage account holding the state container. Azure storage account names are GLOBALLY unique and allow ONLY lowercase letters and digits — no hyphens, 3-24 characters — so this is a fixed literal rather than anything derived. Change it if the default is taken; keep backend.hcl in step."
  type        = string
  default     = "alethiatfstate"

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.state_storage_account_name))
    error_message = "state_storage_account_name must be 3-24 characters of lowercase letters and digits only (Azure's rule — no hyphens, no uppercase)."
  }
}

variable "state_container_name" {
  description = "Blob container holding the state blobs. Matches `container_name` in backend.hcl."
  type        = string
  default     = "tfstate"
}

variable "state_writer_principal_ids" {
  description = <<-EOT
    Entra object ids granted `Storage Blob Data Contributor` on the state account — the maintainers
    who run `tofu apply` against infra/azure-e2e.

    This is NOT optional decoration. The account is created with `shared_access_key_enabled = false`
    so that no storage key exists to leak, which means the ONLY way to read or write state is an
    Entra role assignment. Leave this empty and every `tofu init` against the real backend fails
    with a 403 that looks like a backend misconfiguration rather than a missing grant.

    Get yours with `az ad signed-in-user show --query id -o tsv`.
  EOT
  type        = list(string)
  default     = []
}

variable "state_network_allowed_cidrs" {
  description = <<-EOT
    Public IP ranges allowed to reach the state account. Non-empty flips the account's network
    default action to `Deny`, so ONLY these ranges (plus trusted Azure services) can reach it.

    Empty by default, and that is a deliberate trade rather than an oversight. This account is
    reached from a maintainer's laptop, whose address changes with the network they are on; a
    default-Deny with a stale allowlist locks the only person who can apply these stacks out of the
    state that describes them. The account's real wall is that it has no shared key to steal
    (`shared_access_key_enabled = false`) — every request carries an Entra identity that must hold
    `Storage Blob Data Contributor`. Set this if you have a stable egress address.
  EOT
  type        = list(string)
  default     = []
}

variable "state_retention_days" {
  description = "How long soft-deleted blobs and containers are recoverable. This is the recovery window for 'someone deleted the state', so it is deliberately generous."
  type        = number
  default     = 30

  validation {
    condition     = var.state_retention_days >= 7 && var.state_retention_days <= 365
    error_message = "state_retention_days must be between 7 and 365 (Azure's own bounds for blob soft delete)."
  }
}
