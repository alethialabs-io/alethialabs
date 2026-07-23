# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Doppler — pluggable external secrets store (SaaS). Provisions a placeholder secret per Project
# secret under the connection's project+config so applications resolve them from Doppler. Composed by
# the runner when a Project selects Doppler for its secrets provider; the native cloud secret store is
# guarded off via `secrets_provider` in project/<cloud>. Auth is a WRITE-CAPABLE Doppler API token
# (personal or Service-Account) — a read-only service token cannot manage secrets.

terraform {
  required_providers {
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.21"
    }
  }
}

provider "doppler" {
  doppler_token = var.doppler_token
}

resource "doppler_secret" "secret" {
  for_each = toset(var.secret_names)
  project  = var.doppler_project
  config   = var.doppler_config
  name     = each.value
  # Placeholder payload — applications/operators populate the real value. Keeping the entry under
  # management lets the platform track and rotate it.
  value = "managed-by-alethia"
}
