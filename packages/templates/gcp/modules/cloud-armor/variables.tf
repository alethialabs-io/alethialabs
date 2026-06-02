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
# Cloud Armor
################################################################################

variable "rules" {
  type = list(object({
    priority    = number
    action      = string
    expression  = string
    description = string
  }))
  description = "List of Cloud Armor security policy rules. Each rule needs a unique priority, an action (allow/deny), a CEL expression, and a description"
  default     = []
}

variable "enable_rate_limiting" {
  type        = bool
  description = "Whether to add a rate-limiting rule to the security policy"
  default     = false
}

variable "rate_limit_threshold" {
  type        = number
  description = "Maximum number of requests per minute per IP when rate limiting is enabled"
  default     = 100
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
