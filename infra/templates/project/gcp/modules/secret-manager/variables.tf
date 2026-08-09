################################################################################
# General
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
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
# Secret Manager
################################################################################

variable "secrets" {
  type = list(object({
    name          = string
    generate      = bool
    length        = optional(number, 32)
    special_chars = optional(bool, true)
  }))
  description = "List of secrets to create. When generate=true, a random password is auto-generated as the initial version"
}

variable "secret_keepers" {
  type        = map(map(string))
  default     = {}
  description = "Per-secret rotation keepers, keyed by secret name. Changing any value under a name re-generates that secret's password; a name absent from the map keeps its value forever. Empty is behavior-preserving."
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
