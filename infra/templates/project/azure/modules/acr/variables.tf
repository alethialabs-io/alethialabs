variable "location" {
  description = "Azure region for the container registry"
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

variable "registry_name" {
  description = "Name of the container registry. Derived by the caller (local.azure_acr_name in checks_naming.tf), which strips every non-alphanumeric and applies Azure's 5-50 character cap. Derived at the template root, not here, so it stays reachable from `tofu test`."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "sku" {
  description = "SKU tier for the container registry (Basic, Standard, Premium)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
