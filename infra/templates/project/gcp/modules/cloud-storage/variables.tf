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

# An object type is a CONTRACT with the caller, and an attribute missing from it is not an error —
# tofu converts the incoming value to this type and DISCARDS everything it does not name, without a
# word. Five attributes the root declared were being discarded here on every apply.
variable "buckets" {
  type = list(object({
    name_suffix   = string
    storage_class = optional(string, "STANDARD")
    versioning    = optional(bool, true)
    lifecycle_age = optional(number)
    # `public_access` is the switch the canvas shows. `location`, `force_destroy`, `cors_origins`
    # and `cors_methods` were dropped at this boundary in exactly the same way; all five are wired
    # to a resource argument in main.tf.
    location      = optional(string)
    public_access = optional(bool, false)
    force_destroy = optional(bool, false)
    cors_origins  = optional(list(string), [])
    cors_methods  = optional(list(string), [])
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
