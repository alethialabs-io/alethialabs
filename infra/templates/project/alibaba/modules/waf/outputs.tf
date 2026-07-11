# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "Id of the WAF v3 instance"
  value       = alicloud_wafv3_instance.this.instance_id
}
