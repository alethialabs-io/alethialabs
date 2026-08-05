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

variable "namespace_name" {
  description = "Name of the Service Bus namespace. Derived by the caller (local.azure_service_bus_name in checks_naming.tf) against Azure's 6-50 character cap. Derived at the template root, not here, so it stays reachable from `tofu test`."
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
    # Ordered delivery, via Service Bus sessions. Optional-with-false so an existing queue whose
    # tfvars entry predates the key plans identically. The root's checks_queue.tf refuses the
    # session-on-Basic combination at plan time, because Azure only refuses it at apply.
    requires_session = optional(bool, false)
    # #1994: the root's `service_bus_queues` is map(any), so this key passed the root happily and was
    # then DROPPED HERE — OpenTofu discards object attributes a declared type omits, with no error
    # and no plan diff. null (not a literal) so a queue that never set a retention keeps Azure's own
    # default rather than being pinned to whatever we would have guessed.
    default_message_ttl = optional(string, null)
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
