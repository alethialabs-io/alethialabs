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

variable "policy_name" {
  description = "Name of the web application firewall policy. Derived by the caller (local.azure_waf_policy_name in checks_naming.tf) against an adopted 80-character budget. Derived at the template root, not here, so it stays reachable from `tofu test`."
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
