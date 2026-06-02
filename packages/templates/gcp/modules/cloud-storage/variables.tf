################################################################################
# Provider variables
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region (used as bucket location)"
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
# Bucket configuration
################################################################################

variable "buckets" {
  type = list(object({
    name_suffix   = string
    storage_class = optional(string, "STANDARD")
    versioning    = optional(bool, true)
    lifecycle_age = optional(number)
    iam_bindings = optional(list(object({
      role   = string
      member = string
    })))
  }))
  description = <<-EOT
    List of buckets to create. Each bucket is prefixed with project_name-environment.
    Example:
      buckets = [
        {
          name_suffix   = "assets"
          storage_class = "STANDARD"
          versioning    = true
          lifecycle_age = 90
          iam_bindings = [
            { role = "roles/storage.objectViewer", member = "serviceAccount:my-sa@project.iam.gserviceaccount.com" }
          ]
        },
        {
          name_suffix   = "backups"
          storage_class = "NEARLINE"
          versioning    = false
          lifecycle_age = 365
        },
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
