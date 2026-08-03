# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that NAMING-002 actually produces a name Azure will accept.
#
# The Key Vault name shipped as a bare composition, "<project_name>-<environment>-kv", with a `check`
# block guarding it — and `check` only ever WARNS, so the azure nightly failed at PLAN on azurerm's
# own validation every single run and created nothing (#1873). The guard existed and was useless.
#
# So the fix is by CONSTRUCTION, and what has to be pinned is the construction: that a name which
# fits is left BYTE-IDENTICAL (no silent rename of a live vault), that an overflowing one lands
# inside 24 characters, and that truncation cannot make two environments collide on one vault —
# which would quietly hand them each other's secrets.
#
# The digests below are literal on purpose. Recomputing sha256 inside the assertion would pass
# against a broken derivation, since both sides would drift together.
#
# Providers are mocked and provision_aks is off, so this needs no credentials and runs on any PR.

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-0000000000aa"
      subscription_id = "00000000-0000-0000-0000-000000000001"
      client_id       = "00000000-0000-0000-0000-0000000000bb"
      object_id       = "00000000-0000-0000-0000-0000000000cc"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/networkSecurityGroups/mock" }
  }
  mock_resource "azurerm_route_table" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/routeTables/mock" }
  }

  # checks_secrets.tf asserts the vault URI starts with https://, which the generated string does not.
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
  }
}

mock_provider "azuread" {}
mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000001"
  location        = "westeurope"
  environment     = "production"
  project_name    = "alethia-nl"

  # NAMING-002 is decided from plain variables, before any resource exists — that is the property
  # that makes it testable at all. No cluster is needed to reach it.
  provision_aks = false
}

################################################################################
# 1. A name that FITS is never touched
################################################################################

# The backward-compatibility guarantee. Every vault that exists today has a name inside the cap, so
# the derivation must leave those byte-identical — a rename would force REPLACEMENT of the store
# holding the environment's secrets.
run "a_short_name_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-prod-kv"
    error_message = "A 15-character vault name must be kept verbatim, got ${local.azure_key_vault_name}."
  }
}

# The exact boundary. 24 is legal, so it must NOT fall back — an off-by-one here would rename every
# vault sitting exactly on the cap.
run "a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-nl-production-kv" && local.azure_key_vault_name_len == 24
    error_message = "A name of exactly 24 characters must keep the readable form, got ${local.azure_key_vault_name} (${local.azure_key_vault_name_len} chars)."
  }
}

################################################################################
# 2. A name that OVERFLOWS falls back, and lands inside the cap
################################################################################

# One character over is the first case that must fall back.
run "a_name_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production1"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-nl-produ-53089e7"
    error_message = "A 25-character name must fall back to truncate-plus-digest, got ${local.azure_key_vault_name}."
  }
}

# THE case from #1873 — the e2e nightly's own environment, "<run_id>-<attempt>". This is the name
# that failed at plan on every azure nightly run.
run "the_e2e_nightly_environment_fits" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-nl-30829-b7eda1b"
    error_message = "The e2e nightly environment must render a 24-char vault name, got ${local.azure_key_vault_name}."
  }

  assert {
    condition     = local.azure_key_vault_name_len <= 24
    error_message = "NAMING-002 produced ${local.azure_key_vault_name_len} chars — Azure caps Key Vault names at 24."
  }
}

# Azure rejects a name ending in a dash, so a truncation landing on one must trim it. `trimsuffix`
# would only remove a single trailing dash; the derivation uses a regex so a run of them cannot
# survive.
run "a_truncation_landing_on_a_hyphen_trims_it" {
  command = plan

  variables {
    project_name = "alethia-labs-nl"
    environment  = "production"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-labs-nl-68b6cf6"
    error_message = "A truncation landing on a hyphen must trim it, got ${local.azure_key_vault_name}."
  }
}

################################################################################
# 3. Truncation must not COLLIDE
################################################################################

# The reason the digest is over the FULL name and not the truncated stem. These two environments
# share the first 16 characters exactly — under plain truncation they would resolve to ONE vault and
# silently share every secret in it. Two runs of the nightly are precisely this shape.
run "two_environments_sharing_a_prefix_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-nl-30829-b7eda1b"
    error_message = "Expected the -1 environment's own digest, got ${local.azure_key_vault_name}."
  }
}

run "two_environments_sharing_a_prefix_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-2"
  }

  assert {
    condition     = local.azure_key_vault_name == "alethia-nl-30829-bf7c970"
    error_message = "Expected the -2 environment's own digest (distinct from -1's b7eda1b), got ${local.azure_key_vault_name}."
  }
}
