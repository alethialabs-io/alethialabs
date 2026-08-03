################################################################################
# Provider variables
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

################################################################################
# Naming variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed (e.g. staging, production)"
}

variable "project_name" {
  type        = string
  description = "Application name used as a prefix for resource names"
}

################################################################################
# Topics and subscriptions
################################################################################

variable "topics" {
  type = map(object({
    message_retention_duration = optional(string, "86400s")
    subscriptions = list(object({
      name                 = string
      ack_deadline_seconds = optional(number, 10)
      # Ordered delivery, per orderingKey. Optional-with-false so a subscription whose tfvars entry
      # predates the key plans identically — the argument forces replacement, and a subscription
      # replaced under a running consumer loses its unacknowledged backlog.
      enable_message_ordering = optional(bool, false)
    }))
  }))
  description = <<-EOT
    Map of topics to create. Each topic can have multiple subscriptions.
    Example:
      topics = {
        events = {
          message_retention_duration = "86400s"
          subscriptions = [
            { name = "event-processor", ack_deadline_seconds = 20, enable_message_ordering = true },
            { name = "event-logger" },
          ]
        }
      }
  EOT
  default     = {}
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
