# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "Id of the Container Registry instance"
  value       = alicloud_cr_ee_instance.this.id
}

output "namespace" {
  description = "Name of the created registry namespace"
  value       = alicloud_cr_ee_namespace.this.name
}
