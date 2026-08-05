# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "vpc_id" {
  description = "Id of the VPC"
  value       = alicloud_vpc.this.id
}

output "vswitch_ids" {
  description = "Ids of the created vswitches (one per availability zone)"
  value       = alicloud_vswitch.this[*].id
}

# Empty when the allow-list is empty, so the caller can pass it straight through to the node pool
# without a conditional of its own.
output "operator_allow_list_security_group_ids" {
  description = "Id of the operator allow-list security group, or [] when no allow-list is set"
  value       = alicloud_security_group.operator_allow_list[*].id
}
