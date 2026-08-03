# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# NAMING-002 — derived Azure resource names that must fit a hard API cap.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new naming derivations for THIS feature here; never append to checks.tf.

locals {
  # ── Key Vault: the tightest name limit on the whole Azure surface, 3-24 characters ──
  #
  # The readable form is "<project_name>-<environment>-kv", and it has NO length budget. The e2e
  # nightly renders:
  #
  #   alethia-nl  -  30829641000-1  -  kv    =  27 characters
  #      10              13            3
  #
  # which Azure refuses at PLAN time, before a single resource is created:
  #
  #   Error: "name" may only contain alphanumeric characters and dashes and must be between 3-24
  #   chars  (modules/key-vault/main.tf line 7)
  #
  # No fixture tuning fixes this. A GitHub run id is 11 digits today and only grows, so the
  # environment alone is 13 characters and the suffix is 3 — leaving 8 for the project name, which
  # no realistic customer name fits. And Key Vault is not optional: it is where the Azure secrets
  # live, and checks.tf requires a vault_uri whenever AKS is up.
  #
  # A `check` block for exactly this already existed and did nothing, because `check` only ever
  # WARNS — the plan still failed on azurerm's own validation. That is the #1716 lesson repeated on
  # another cloud: a name with no headroom has to be solved by CONSTRUCTION, not by assertion.
  #
  # So derive it defensively, the same way gcp/checks_naming.tf derives gke_node_pool_name: keep the
  # readable form whenever it fits, and otherwise fall back to a deterministic truncate-plus-digest
  # of at most 24 characters (16 + "-" + 7). Digesting the FULL name rather than the truncated stem
  # is what stops two environments sharing a 16-character prefix from colliding on one vault —
  # silent truncation without a digest would be worse than the bug, because two environments would
  # race for the same vault and quietly share secrets.
  #
  # Backward-compatible by construction: the fallback only triggers above 24 characters, which is
  # exactly where Azure refuses to create the vault at all. No vault that exists today can change
  # name — and a rename would force replacement of the store holding the environment's secrets.
  #
  # Trailing dashes are stripped with a regex rather than `trimsuffix` so a truncation landing on
  # "--" cannot leave one behind: Azure also rejects a name ending in a dash.
  azure_key_vault_name_max  = 24
  azure_key_vault_name_full = "${var.project_name}-${var.environment}-kv"
  azure_key_vault_name = (
    length(local.azure_key_vault_name_full) <= local.azure_key_vault_name_max
    ? local.azure_key_vault_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_key_vault_name_full, 0, 16), "/-+$/", ""),
      substr(sha256(local.azure_key_vault_name_full), 0, 7),
    )
  )
  azure_key_vault_name_len = length(local.azure_key_vault_name)
}

# The derivation is only worth anything if it actually lands inside the cap. This asserts the OUTPUT,
# not the input — the old check asserted the input and let the plan fail anyway.
#
# Unlike NAMING-001 on gcp there is no terraform_data precondition here, and that is deliberate: this
# name can no longer overflow by construction, so a precondition could only fire on a bug in the
# arithmetic above. checks_naming.tftest.hcl is the right place to catch that, and it does — it runs
# on every PR under mocked providers, where a precondition would need a plan against real Azure.
check "key_vault_name_within_limit" {
  assert {
    condition     = local.azure_key_vault_name_len >= 3 && local.azure_key_vault_name_len <= local.azure_key_vault_name_max
    error_message = "NAMING-002: the derived Key Vault name '${local.azure_key_vault_name}' is ${local.azure_key_vault_name_len} chars, outside Azure's 3-${local.azure_key_vault_name_max} range. The truncate-plus-digest fallback in checks_naming.tf is wrong."
  }
}
