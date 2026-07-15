variable "location" {
  description = "Azure region for the Redis cache"
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

# Azure MANAGED REDIS sku.
#
# The retired Azure Cache for Redis took a (sku, family, capacity) triple — e.g. Basic/C/0. Managed
# Redis takes a single sku_name. Its smallest tier is Balanced_B0; the root module maps the legacy
# Basic/Standard/Premium knob onto Balanced_B0/B1/B3 for continuity, and an operator can override
# this to pick an exact tier (and therefore the cost) on purpose.
variable "sku_name" {
  description = "Azure Managed Redis sku, e.g. Balanced_B0 (smallest), Balanced_B1, Balanced_B3, MemoryOptimized_M10, ComputeOptimized_X3, FlashOptimized_A250."
  type        = string
  default     = "Balanced_B0"

  validation {
    condition     = can(regex("^(Balanced_B|MemoryOptimized_M|ComputeOptimized_X|FlashOptimized_A)[0-9]+$", var.sku_name))
    error_message = "sku_name must be an Azure Managed Redis sku: Balanced_B*, MemoryOptimized_M*, ComputeOptimized_X* or FlashOptimized_A*."
  }
}

variable "multi_az" {
  description = "Spread the Managed Redis cluster across availability zones"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
