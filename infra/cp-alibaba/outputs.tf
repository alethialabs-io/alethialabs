# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Public IP of the control-plane VM (set as DEPLOY_HOST)."
  value       = alicloud_instance.cp.public_ip
}

output "instance_id" {
  description = "ECS instance ID."
  value       = alicloud_instance.cp.id
}
