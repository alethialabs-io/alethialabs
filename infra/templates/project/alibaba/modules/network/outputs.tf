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
