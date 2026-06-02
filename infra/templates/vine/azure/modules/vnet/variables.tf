################################################################################
# Provider variables
################################################################################

variable "location" {
  type        = string
  description = "Azure region to deploy to"
}

################################################################################
# Utility variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

variable "resource_group_name" {
  type        = string
  description = "Name of the Azure resource group"
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources"
}

################################################################################
# Networking variables
################################################################################

variable "vnet_cidr" {
  type        = string
  description = "CIDR block for the virtual network"
  default     = "10.0.0.0/16"
}

variable "single_nat_gateway" {
  type        = bool
  description = "Whether to use a single NAT gateway for all private subnets"
  default     = true
}
