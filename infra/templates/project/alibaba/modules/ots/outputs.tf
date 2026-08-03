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

# Read off the RESOURCE, so `checks_ots.tftest.hcl` can assert from the root what the plan will
# actually build. #1836 was invisible for exactly this reason: the key the caller sent and the key
# the table got were different values, and nothing in the tree ever compared them.
output "table_primary_keys" {
  description = "The primary key each planned table will be created with, by table name"
  value = {
    for name, t in alicloud_ots_table.this :
    name => [for pk in t.primary_key : { name = pk.name, type = pk.type }]
  }
}
