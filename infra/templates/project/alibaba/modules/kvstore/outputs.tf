# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "Id of the KVStore instance"
  value       = alicloud_kvstore_instance.this.id
}

output "connection_domain" {
  description = "Private connection domain of the KVStore instance"
  value       = alicloud_kvstore_instance.this.connection_domain
}

output "port" {
  description = "Port of the KVStore instance"
  value       = alicloud_kvstore_instance.this.port
}
