# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariants, reported as WARNINGS on every plan (OpenTofu `check` blocks never block an apply).
# The two refusals that must fail the plan are preconditions in main.tf instead: same-subscription and
# cross-tenant. The canary length is a variable validation. Both of those do fail.

# ── The grant stays on ONE secret ─────────────────────────────────────────────────────────────
check "grant_is_secret_scoped" {
  assert {
    condition     = azurerm_role_assignment.eso_canary_reader.scope == azurerm_key_vault_secret.canary.resource_versionless_id
    error_message = "The Key Vault Secrets User grant must be scoped to the canary secret, never the vault or the subscription. A standing identity with vault-wide read is a permanent widening."
  }
}

# ── The grant is read-only ────────────────────────────────────────────────────────────────────
check "grant_is_read_only" {
  assert {
    condition     = azurerm_role_assignment.eso_canary_reader.role_definition_name == "Key Vault Secrets User"
    error_message = "The standing identity must hold Key Vault Secrets User (get/list) only; anything wider lets a compromised nightly cluster write or delete account-B secrets."
  }
}

# ── The standing identity is not in a resource group the e2e sweeper deletes ──────────────────
check "identity_group_is_not_sweepable" {
  assert {
    condition     = !contains(keys(var.tags), "alethia:project-id")
    error_message = "The tags carry alethia:project-id — scripts/e2e/azure-cleanup.sh deletes resource groups by that tag, and would delete the standing identity (and with it the grant) on its next sweep."
  }
}
