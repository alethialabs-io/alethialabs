################################################################################
# Provider variables
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region (used as default location_id if location_id is not set)"
}

################################################################################
# Naming variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed (e.g. staging, production)"
}

variable "project_name" {
  type        = string
  description = "Application name used as a prefix for resource names"
}

################################################################################
# Database configuration
################################################################################

variable "database_type" {
  type        = string
  description = "Firestore database type: FIRESTORE_NATIVE or DATASTORE_MODE"
  default     = "FIRESTORE_NATIVE"

  validation {
    condition     = contains(["FIRESTORE_NATIVE", "DATASTORE_MODE"], var.database_type)
    error_message = "database_type must be FIRESTORE_NATIVE or DATASTORE_MODE"
  }
}

variable "location_id" {
  type        = string
  description = "Location for the Firestore database (overrides region if set, e.g. nam5 for multi-region)"
  default     = null
}

################################################################################
# Indexes
################################################################################

variable "indexes" {
  type = list(object({
    collection  = string
    query_scope = optional(string, "COLLECTION")
    fields = list(object({
      field_path   = string
      order        = optional(string)
      array_config = optional(string)
    }))
  }))
  description = <<-EOT
    List of composite indexes to create.
    Example:
      indexes = [
        {
          collection = "users"
          fields = [
            { field_path = "status", order = "ASCENDING" },
            { field_path = "created_at", order = "DESCENDING" },
          ]
        }
      ]
  EOT
  default     = []
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
