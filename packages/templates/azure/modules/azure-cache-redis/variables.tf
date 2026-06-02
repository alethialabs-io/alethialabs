variable "location" {
  description = "Azure region for the Redis cache"
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

variable "sku" {
  description = "SKU tier for the Redis cache (Basic, Standard, Premium)"
  type        = string
}

variable "family" {
  description = "SKU family for the Redis cache (C for Basic/Standard, P for Premium)"
  type        = string
}

variable "capacity" {
  description = "Size of the Redis cache instance"
  type        = number
}

variable "redis_version" {
  description = "Redis server version"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for VNet integration (Premium SKU only)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
