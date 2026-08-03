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

  validation {
    condition     = var.backup_tier == null || contains(["Continuous7Days", "Continuous30Days"], var.backup_tier)
    error_message = "backup_tier must be null, Continuous7Days or Continuous30Days."
  }
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
