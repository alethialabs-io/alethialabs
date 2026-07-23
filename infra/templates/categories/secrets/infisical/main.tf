# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Infisical — pluggable external secrets store (SaaS or self-hosted). Provisions a placeholder secret
# per Project secret in the connection's workspace/env/folder so applications resolve them from
# Infisical. Composed by the runner when a Project selects Infisical for its secrets provider; the
# native cloud secret store is guarded off via `secrets_provider` in project/<cloud>. Auth is Universal
# Auth (a machine-identity client_id + client_secret).

terraform {
  required_providers {
    infisical = {
      source  = "Infisical/infisical"
      version = "~> 0.19"
    }
  }
}

provider "infisical" {
  host = var.infisical_host
  auth = {
    universal = {
      client_id     = var.infisical_client_id
      client_secret = var.infisical_client_secret
    }
  }
}

resource "infisical_secret" "secret" {
  for_each     = toset(var.secret_names)
  workspace_id = var.infisical_workspace_id
  env_slug     = var.infisical_env_slug
  folder_path  = var.infisical_folder_path
  name         = each.value
  # Placeholder payload — applications/operators populate the real value. Keeping the entry under
  # management lets the platform track and rotate it.
  value = "managed-by-alethia"
}
