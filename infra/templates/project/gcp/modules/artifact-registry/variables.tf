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
