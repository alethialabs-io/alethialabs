variable "location" {
  description = "Azure region for the WAF policy"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, staging, prod)"
  type        = string
}

variable "project_name" {
  description = "Project name used in resource naming"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "rules" {
  description = "List of custom WAF rules"
  type = list(object({
    priority         = number
    rule_type        = string
    action           = string
    match_conditions = optional(list(any), [])
  }))
  default = []
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
