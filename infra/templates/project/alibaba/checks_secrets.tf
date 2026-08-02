# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# RRSA workload-identity + external-secrets invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "ack_rrsa_provider_present" {
  assert {
    condition     = !var.provision_ack || length(trimspace(module.cluster[0].rrsa_oidc_provider_arn)) > 0
    error_message = "ACK RRSA (workload identity) did not report an OIDC provider ARN — in-cluster components can't assume RAM roles."
  }
}

check "external_secrets_rrsa_role_present" {
  assert {
    condition     = !local.eso_rrsa_enabled || length(trimspace(try(alicloud_ram_role.external_secrets[0].arn, ""))) > 0
    error_message = "Native KMS secrets exist on an ACK cluster but the external-secrets RRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}
