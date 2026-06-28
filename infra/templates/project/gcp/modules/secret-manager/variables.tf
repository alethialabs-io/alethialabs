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

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
