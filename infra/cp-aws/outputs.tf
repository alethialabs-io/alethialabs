# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Elastic IP of the control-plane instance (set as DEPLOY_HOST)."
  value       = aws_eip.cp.public_ip
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.cp.id
}
