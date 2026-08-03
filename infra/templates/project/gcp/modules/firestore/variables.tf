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

variable "point_in_time_recovery" {
  type        = bool
  default     = false
  description = <<-EOT
    Whether to enable point-in-time recovery on the database.

    A property of the DATABASE, not of a table: GCP allows one Firestore database per project and
    the canvas's NoSQL "tables" are collections inside it, so the caller aggregates the per-table
    switch with ANY before handing it here.

    true keeps 1-minute snapshots for 7 days; false reaches back one hour, which is also
    Firestore's own default. `point_in_time_recovery_enablement` is NOT a force-new argument, so
    changing this updates the existing database in place rather than replacing it — which matters
    because this module sets deletion_policy = "DELETE" outside production.
  EOT
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
