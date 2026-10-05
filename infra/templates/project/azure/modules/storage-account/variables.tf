variable "location" {
  description = "Azure region for the storage account"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, staging, prod)"
  type        = string
}

variable "project_name" {
  description = "Project name used in resource naming"
  type        = string
}

variable "account_name" {
  description = "Name of the storage account. Derived by the caller (local.azure_storage_account_name in checks_naming.tf), which lowercases, strips every non-alphanumeric and applies Azure's 3-24 character cap. Derived at the template root, not here, so it stays reachable from `tofu test`."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "account_tier" {
  description = "The tier of the storage account (Standard or Premium)"
  type        = string
  default     = "Standard"
}

variable "replication_type" {
  description = "The replication type for the storage account (LRS, GRS, RAGRS, ZRS)"
  type        = string
  default     = "LRS"
}

variable "containers" {
  description = <<-EOT
    List of blob containers to create.

    `versioning_enabled` is stated PER CONTAINER because that is how it is chosen, but Azure blob
    versioning is a property of the storage ACCOUNT and this module creates exactly one — see the
    aggregation in main.tf for what that means in practice.

    `cors_origins` is the same shape for the same reason: CORS is `blob_properties.cors_rule` on the
    account, so the per-container lists are unioned (#1995).
  EOT
  type = list(object({
    name               = string
    access_type        = optional(string, "private")
    versioning_enabled = optional(bool, false)
    cors_origins       = optional(list(string), [])
    cmek_enabled       = optional(bool, false)
  }))
  default = []
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# Customer-managed key (CUSTOMIZABILITY-PARITY top gap #8). cmek_enabled is the GATE (a value known
# at plan); the two ids are only carried. Set together or not at all; the root
# creates both and grants the identity on the key before this account is planned.
variable "cmek_enabled" {
  description = "Encrypt the account with cmek_key_id as cmek_identity_id. False keeps Microsoft-managed keys (unchanged)."
  type        = bool
  default     = false
}

variable "cmek_key_id" {
  description = "Versionless Key Vault key id to encrypt the account with. Read only when cmek_enabled is true."
  type        = string
  default     = ""
}

variable "cmek_identity_id" {
  description = "User-assigned identity resource id the account unwraps cmek_key_id as. Required when cmek_key_id is set."
  type        = string
  default     = ""

  validation {
    # Not cross-checked against cmek_key_id (a validation may not read a second variable on the
    # runner's tofu); the root always sets both or neither.
    condition     = var.cmek_identity_id == "" || can(regex("(?i)/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[^/]+$", var.cmek_identity_id))
    error_message = "cmek_identity_id must be a user-assigned identity resource id."
  }
}
