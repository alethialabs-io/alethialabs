terraform {
  required_version = "~> 1.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
}

################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # Flatten subscriptions so we can use for_each on them
  subscriptions = merge([
    for topic_key, topic in var.topics : {
      for sub in topic.subscriptions :
      "${topic_key}-${sub.name}" => {
        topic_key            = topic_key
        subscription_name    = sub.name
        ack_deadline_seconds = sub.ack_deadline_seconds
      }
    }
  ]...)
}

################################################################################
# Pub/Sub topics
################################################################################

resource "google_pubsub_topic" "this" {
  for_each = var.topics

  name    = "${local.name_prefix}-${each.key}"
  project = var.project_id

  message_retention_duration = each.value.message_retention_duration

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "terraform"
    topic       = each.key
  })
}

################################################################################
# Pub/Sub subscriptions
################################################################################

resource "google_pubsub_subscription" "this" {
  for_each = local.subscriptions

  name    = "${local.name_prefix}-${each.value.subscription_name}"
  project = var.project_id
  topic   = google_pubsub_topic.this[each.value.topic_key].id

  ack_deadline_seconds       = each.value.ack_deadline_seconds
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expires
  }

  labels = merge(var.labels, {
    environment  = var.environment
    managed-by   = "terraform"
    topic        = each.value.topic_key
    subscription = each.value.subscription_name
  })
}
