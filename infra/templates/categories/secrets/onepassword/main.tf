# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# 1Password — pluggable external secrets store (SaaS). Provisions a placeholder password item per
# Project secret in the connection's vault so applications resolve them from 1Password. Composed by the
# runner when a Project selects 1Password for its secrets provider; the native cloud secret store is
# guarded off via `secrets_provider` in project/<cloud>. Auth is a 1Password Service Account token
# (supports item creation in the v3.x provider); the vault is referenced by its UUID.

terraform {
  required_providers {
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 3.3"
    }
  }
}

provider "onepassword" {
  service_account_token = var.op_service_account_token
}

resource "onepassword_item" "secret" {
  for_each = toset(var.secret_names)
  vault    = var.op_vault
  title    = each.value
  category = "password"
  # Placeholder item — the provider generates a random password so no value is hardcoded in the
  # module. Applications/operators overwrite it with the real value; keeping the item under
  # management lets the platform track and rotate it.
  password_recipe {
    length  = 32
    symbols = false
  }
}
