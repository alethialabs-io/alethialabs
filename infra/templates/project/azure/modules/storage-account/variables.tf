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
  EOT
  type = list(object({
    name               = string
    access_type        = optional(string, "private")
    versioning_enabled = optional(bool, false)
  }))
  default = []
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
