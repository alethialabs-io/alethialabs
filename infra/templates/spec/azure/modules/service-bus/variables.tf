variable "location" {
  description = "Azure region for the Service Bus namespace"
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
  description = "SKU tier for the Service Bus namespace (Basic, Standard, Premium)"
  type        = string
}

variable "queues" {
  description = "Map of queues to create in the namespace"
  type = map(object({
    max_delivery_count = optional(number, 10)
    lock_duration      = optional(string, "PT1M")
  }))
  default = {}
}

variable "topics" {
  description = "Map of topics to create with their subscriptions"
  type = map(object({
    subscriptions = list(object({
      name               = string
      max_delivery_count = optional(number, 10)
    }))
  }))
  default = {}
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
