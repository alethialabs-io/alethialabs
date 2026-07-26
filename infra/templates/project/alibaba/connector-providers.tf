# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pluggable-connector guard variables. Set by the runner (categories.Compose):
# when a Project selects a pluggable provider for a category, the matching variable
# holds that provider's slug and the cloud-native resource below is skipped — the
# pluggable module (composed into _categories.tf.json) takes over. Default
# "native" preserves the cloud-native behavior.

variable "dns_provider" {
  description = "DNS provider slug; \"native\" uses the cloud-native DNS (AliDNS)."
  type        = string
  default     = "native"
}

variable "secrets_provider" {
  description = "Secrets provider slug; \"native\" uses the cloud-native secrets store (KMS)."
  type        = string
  default     = "native"
}

variable "registry_provider" {
  description = "Container registry provider slug; \"native\" uses the cloud-native registry (CR)."
  type        = string
  default     = "native"
}

# Declared for uniformity with the other clouds (Compose sets this guard on every cloud). Alibaba has
# NO cross-account keyless registry provider — token clouds are an explicit exclusion (see the PR B
# design doc), so this stays "native" for Alibaba projects; no keyless pull role is wired here.
variable "registry_pull_provider" {
  description = "Cross-account keyless registry-pull provider slug; \"native\" means no cross-account pull. Unused on Alibaba (no keyless registry support)."
  type        = string
  default     = "native"
}

# Unlike the registry (a token-cloud exclusion), Alibaba DOES support cross-account keyless secrets: KMS
# Secrets Manager + RRSA. No cluster-side resource is wired here — the seams renders the alibaba
# ClusterSecretStore whose RRSA auth exchanges the projected token directly for the TARGET account's role
# via that account's OIDC provider (see infra/connector/alibaba/secrets-xacct). This guard stays "native"
# unless the alibaba-kms-xacct connector is selected.
variable "secrets_xacct_provider" {
  description = "Cross-account keyless cloud-secret-manager provider slug (alibaba-kms-xacct); \"native\" means no cross-account KMS. SEPARATE from secrets_provider so the cluster keeps its native store AND reads a foreign-account KMS Secrets Manager (an additional ClusterSecretStore)."
  type        = string
  default     = "native"
}
