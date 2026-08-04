# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pluggable-connector guard variables. Set by the runner (categories.Compose): when a project
# selects a pluggable provider for a category, the matching variable holds that provider's slug
# and the cloud-native resource is skipped — the pluggable module (composed into
# _categories.tf.json) takes over. Default "native" preserves the cloud-native behavior.
#
# Only `dns_provider` is declared here, unlike the four managed clouds which declare five.
# `registry` and `secret` are not offered on Hetzner at all
# (apps/console/lib/cloud-providers/unsupported-kinds.ts), so a registry/secrets guard here would
# gate a resource that does not exist. compose.go sets the other slugs regardless; tofu reports
# them as undeclared-and-ignored, which is the honest state.

variable "dns_provider" {
  description = "DNS provider slug; \"native\" uses the cloud-native (hcloud) DNS zone in dns.tf."
  type        = string
  default     = "native"
}
