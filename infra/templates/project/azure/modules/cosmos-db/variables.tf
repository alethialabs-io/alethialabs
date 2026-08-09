variable "location" {
  description = "Azure region for the Cosmos DB account"
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
  description = "Name of the Cosmos DB account. Derived by the caller (local.azure_cosmos_account_name in checks_naming.tf), which keeps the readable \"<project_name>-<environment>-cosmos\" form while it fits Azure's 3-44 character cap and truncates-plus-digests it above that. Derived at the template root, not here, so it stays reachable from `tofu test`."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "kind" {
  description = "The kind of Cosmos DB account (GlobalDocumentDB or MongoDB)"
  type        = string
  default     = "GlobalDocumentDB"
}

variable "consistency_level" {
  description = "The default consistency level for the Cosmos DB account"
  type        = string
  default     = "Session"
}

variable "collections" {
  description = "List of Cosmos DB containers (collections) to create"
  type = list(object({
    name          = string
    partition_key = optional(string, "/id")
    billing_mode  = optional(string, "PAY_PER_REQUEST")
    # Point-in-time restore is bought per ACCOUNT, so the root module folds this per-container flag
    # into `backup_type` below rather than the module reading it per container.
    point_in_time_recovery = optional(bool, false)
    # Synapse Link analytical (column) storage — a separate, separately-billed feature that is NOT a
    # backup. Read only by azurerm_cosmosdb_sql_container.analytical_storage_ttl; nothing derives it
    # from point_in_time_recovery (#1838).
    analytical_storage_enabled = optional(bool, false)
  }))
  default = []
}

variable "backup_type" {
  description = "Cosmos DB backup mode: Continuous (point-in-time restore) or Periodic (rolling snapshots)."
  type        = string
  default     = "Periodic"

  validation {
    condition     = contains(["Continuous", "Periodic"], var.backup_type)
    error_message = "backup_type must be Continuous or Periodic."
  }
}

variable "backup_tier" {
  description = "Continuous-backup retention tier (Continuous7Days / Continuous30Days). Must be null in Periodic mode."
  type        = string
  default     = null

  # Written to be degenerate-safe rather than short-circuit-safe (#1931). `||` does not
  # short-circuit on the OpenTofu the runner applies with — 1.9.0, per
  # apps/runner/Dockerfile.base TOFU_VERSION and compat matrix `tofu` — so the right-hand
  # `contains()` was called with a null value even when `var.backup_tier == null` was a known
  # `true`, and the module refused its OWN default:
  #
  #   Error: Invalid function argument … while calling contains(list, value) … var.backup_tier is null
  #   1.9.0            → refused (`no_point_in_time_recovery_leaves_the_account_on_periodic_backup`)
  #   1.10.10, 1.12.3  → accepted
  #
  # Note this is a `validation` block, which proves the class reaches variable validation and not
  # only `check`. The fix guards the ARGUMENT rather than adding another disjunct: the one-element
  # comprehension drops a null tier before `contains()` is ever reached, and `alltrue([])` is `true`,
  # so "null is allowed" is stated by the `if` instead of by a disjunct that does not gate anything.
  validation {
    condition     = alltrue([for t in [var.backup_tier] : contains(["Continuous7Days", "Continuous30Days"], t) if t != null])
    error_message = "backup_tier must be null, Continuous7Days or Continuous30Days."
  }
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
