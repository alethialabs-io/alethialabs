# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# HashiCorp Vault — pluggable alternative to the cloud-native secrets store.
# Provisions a KV v2 entry per Project secret so applications resolve them from Vault.
# Composed by the runner when a Project selects Vault for its secrets provider; the
# native secrets resources are guarded off via `secrets_provider` in project/<cloud>.

terraform {
  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 4.0"
    }
  }
}

provider "vault" {
  address = var.vault_address
  token   = var.vault_token
}

resource "vault_kv_secret_v2" "secret" {
  for_each = var.vault_kv_version == "2" ? toset(var.secret_names) : toset([])
  mount    = var.vault_mount_path
  name     = each.value
  # Placeholder payload — applications/operators populate the real value. Keeping
  # the entry under management lets the platform track and rotate it.
  data_json = jsonencode({ managed_by = "alethia" })
}
