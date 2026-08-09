################################################################################
# General
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region to deploy resources"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g. dev, staging, production)"
}

variable "project_name" {
  type        = string
  description = "Name of the project, used in resource naming"
}

################################################################################
# Artifact Registry
################################################################################

variable "repos" {
  type = map(object({
    # OPTIONAL, so a caller that supplies only the switch is not a plan error. It was required while
    # nothing at all called this module (#1835); now that something does, the shape has to match the
    # root's, which makes both attributes optional.
    description    = optional(string, "")
    immutable_tags = optional(bool, true)
    # Named HERE as well as on the root's `artifact_registry_repos`, or tofu's type conversion at
    # the module boundary drops it silently and the switch reads as configurable while doing
    # nothing — which is the exact defect #1844 exists to close, arriving inside its own fix. The
    # same boundary already swallowed `format` once; see the note in gcp/variables.tf.
    vulnerability_scanning = optional(bool, false)
  }))
  default     = {}
  description = "Map of repository names to their configuration"
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
