# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "secret_names" {
  description = "Names of the created KMS secrets"
  value       = [for s in alicloud_kms_secret.this : s.secret_name]
}

output "secret_arns" {
  description = "ARNs of the created KMS secrets"
  value       = [for s in alicloud_kms_secret.this : s.arn]
}
