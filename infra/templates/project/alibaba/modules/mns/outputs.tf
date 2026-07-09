# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "queue_names" {
  description = "Names of the created MNS queues"
  value       = [for q in alicloud_message_service_queue.this : q.queue_name]
}

output "topic_names" {
  description = "Names of the created MNS topics"
  value       = [for t in alicloud_message_service_topic.this : t.topic_name]
}
