# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pluggable-connector guard variables. Set by the runner (categories.Compose):
# when a Project selects a pluggable provider for a category, the matching variable
# holds that provider's slug and the cloud-native resource below is skipped — the
# pluggable module (composed into _categories.tf.json) takes over. Default
# "native" preserves the cloud-native behavior.

variable "dns_provider" {
  description = "DNS provider slug; \"native\" uses the cloud-native DNS."
  type        = string
  default     = "native"
}

variable "secrets_provider" {
  description = "Secrets provider slug; \"native\" uses the cloud-native secrets store."
  type        = string
  default     = "native"
}

variable "registry_provider" {
  description = "Container registry provider slug; \"native\" uses the cloud-native registry."
  type        = string
  default     = "native"
}

variable "registry_pull_provider" {
  description = "Cross-account keyless registry-pull provider slug (ecr-xacct/gar-xacct/acr-xacct); \"native\" means no cross-account pull. SEPARATE from registry_provider so the cluster keeps its native registry AND wires a foreign-account keyless pull."
  type        = string
  default     = "native"
}

variable "secrets_xacct_provider" {
  description = "Cross-account keyless cloud-secret-manager provider slug (azure-kv-xacct); \"native\" means no cross-subscription Key Vault. SEPARATE from secrets_provider so the cluster keeps its native store AND reads a Key Vault in another SUBSCRIPTION (same tenant; an additional ClusterSecretStore). No cluster-side resource: the read grant lives entirely on the target vault (see infra/connector/azure/secrets-xacct). Cross-TENANT is excluded (Azure managed/workload identity can't cross tenants)."
  type        = string
  default     = "native"
}
