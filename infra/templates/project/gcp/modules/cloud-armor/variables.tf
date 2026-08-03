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

variable "default_action" {
  type        = string
  default     = "allow"
  description = "Action for the catch-all default rule (priority 2147483647) — what happens to every request none of the rules above matched. A finite, known set, validated rather than left a free string: a typo here is not a plan error, it is a silently different security posture on the policy that fronts the platform ingress."

  validation {
    condition     = contains(["allow", "deny(403)", "deny(404)", "deny(502)"], var.default_action)
    error_message = "default_action must be one of: allow, deny(403), deny(404), deny(502) — the actions the Cloud Armor API accepts on a security policy rule."
  }
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
