# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_name" {
  description = "Name of the OTS instance"
  value       = alicloud_ots_instance.this.name
}

output "table_names" {
  description = "Names of the created OTS tables"
  value       = [for t in alicloud_ots_table.this : t.table_name]
}
