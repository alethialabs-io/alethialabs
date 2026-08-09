# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "kms" {
  source = "./modules/kms"
  count  = length(var.custom_secrets) > 0 && var.secrets_provider == "native" ? 1 : 0

  name_prefix = local.secret_prefix
  secrets     = var.custom_secrets

  # Rotation handle for the generated secrets above (aws/gcp/azure parity). Empty by default, so
  # this is a new reachable knob rather than a change to any project that already exists.
  secret_keepers = var.custom_secret_keepers
}
