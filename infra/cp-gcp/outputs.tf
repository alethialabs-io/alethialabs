# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "server_ipv4" {
  description = "Static external IP of the control-plane instance (set as DEPLOY_HOST)."
  value       = google_compute_address.cp.address
}

output "instance_name" {
  description = "GCE instance name."
  value       = google_compute_instance.cp.name
}
