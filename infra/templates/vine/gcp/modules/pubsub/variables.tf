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
    }))
  }))
  description = <<-EOT
    Map of topics to create. Each topic can have multiple subscriptions.
    Example:
      topics = {
        events = {
          message_retention_duration = "86400s"
          subscriptions = [
            { name = "event-processor", ack_deadline_seconds = 20 },
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
