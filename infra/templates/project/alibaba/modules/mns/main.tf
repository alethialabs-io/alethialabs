# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
  }
}

# Queues. Optional per-queue tunables are read defensively from the map so the
# console can pass sparse objects.
resource "alicloud_message_service_queue" "this" {
  for_each = var.queues

  queue_name               = each.key
  delay_seconds            = try(each.value.delay_seconds, 0)
  maximum_message_size     = try(each.value.maximum_message_size, 65536)
  message_retention_period = try(each.value.message_retention_period, 345600)
  visibility_timeout       = try(each.value.visibility_timeout, 30)
  polling_wait_seconds     = try(each.value.polling_wait_seconds, 0)
}

# Topics.
resource "alicloud_message_service_topic" "this" {
  for_each = var.topics

  topic_name       = each.key
  max_message_size = try(each.value.maximum_message_size, 65536)
}
