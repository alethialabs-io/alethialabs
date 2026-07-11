# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "kms" {
  source = "./modules/kms"
  count  = length(var.custom_secrets) > 0 && var.secrets_provider == "native" ? 1 : 0

  name_prefix = local.secret_prefix
  secrets     = var.custom_secrets
}
