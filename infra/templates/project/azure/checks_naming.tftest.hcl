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

################################################################################
# 4. The rest of the Azure surface (#1886)
#
# Six more names with the same defect as the Key Vault above and none of its urgency — every one of
# them fits today. They are pinned here for the reason the Key Vault was not: so that "fits today"
# stops being an accident and becomes a property.
#
# Every module that owns one of these is opt-in (create_storage_account, provision_acr,
# create_cosmos_db, create_service_bus, create_azure_cache, azure_waf_enabled), so none is exercised
# by the nightly floor. That is the same blind spot that let the Tablestore overflow sit unseen
# until the Sunday full bar (#1884), and it is why plan-time proof is the proof that matters here.
################################################################################

# The e2e nightly's own inputs, all six at once. Everything must come through the readable form
# byte-identical — these are the names a live azure environment carries.
run "the_e2e_nightly_keeps_every_name_readable" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829349095-1"
  }

  assert {
    condition     = local.azure_storage_account_name == "alethianl308293490951st" && length(local.azure_storage_account_name) == 23
    error_message = "Storage account: expected the readable 23-char form, got ${local.azure_storage_account_name} (${length(local.azure_storage_account_name)} chars)."
  }

  assert {
    condition     = local.azure_acr_name == "acralethianl308293490951"
    error_message = "ACR: expected the readable form, got ${local.azure_acr_name}."
  }

  assert {
    condition     = local.azure_cosmos_account_name == "alethia-nl-30829349095-1-cosmos"
    error_message = "Cosmos: expected the readable form, got ${local.azure_cosmos_account_name}."
  }

  assert {
    condition     = local.azure_service_bus_name == "sb-alethia-nl-30829349095-1"
    error_message = "Service Bus: expected the readable form, got ${local.azure_service_bus_name}."
  }

  assert {
    condition     = local.azure_cache_name == "alethia-nl-30829349095-1-redis"
    error_message = "Managed Redis: expected the readable form, got ${local.azure_cache_name}."
  }

  assert {
    condition     = local.azure_waf_policy_name == "alethia-nl-30829349095-1-waf"
    error_message = "WAF policy: expected the readable form, got ${local.azure_waf_policy_name}."
  }
}

################################################################################
# 4a. Storage account — 3-24, lowercase letters and numbers only
#
# The tightest name on the surface and the one #1886 did not list. It renders 23 of 24 on the e2e
# nightly (asserted above): ONE character, which the next GitHub run-id digit consumes.
#
# It also had a guard already, in checks.tf, and that guard was wrong twice over — `check` only
# warns, and it measured "<environment><project_name>" rather than the "<project_name><environment>st"
# the module actually builds, so it passed at 24 while the real name was 26. Both halves are pinned
# below: the boundary is over the DERIVED name, not a stem.
################################################################################

run "storage_a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829349095-11"
  }

  assert {
    condition     = local.azure_storage_account_name == "alethianl3082934909511st" && length(local.azure_storage_account_name) == 24
    error_message = "A storage account name of exactly 24 characters must be kept verbatim, got ${local.azure_storage_account_name} (${length(local.azure_storage_account_name)} chars)."
  }
}

run "storage_a_name_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829349095-111"
  }

  # 16 characters of stem + 8 hex, joined with NO separator: a hyphen is not legal in a storage
  # account name, so this is the one derivation here that cannot use one.
  assert {
    condition     = local.azure_storage_account_name == "alethianl3082934fdccbe15" && length(local.azure_storage_account_name) == 24
    error_message = "A 25-character storage account name must fall back to truncate-plus-digest, got ${local.azure_storage_account_name}."
  }
}

# The shape fix that rides along: the module stripped hyphens only and never lowercased, so an
# uppercase project_name produced a storage account name Azure refuses outright — and, unlike an
# underscore, an uppercase project_name really can reach a plan (Key Vault, ACR, Service Bus and
# Managed Redis all permit uppercase, so nothing else stops it).
#
# Cosmos does not permit it, and this run pins that too: `expect_failures` asserts the Cosmos shape
# check FIRES here. That is deliberate rather than incidental. Cosmos's first character is NOT
# normalised by the derivation, because normalising it would rename a live account — so the correct
# behaviour for an uppercase project_name is exactly this: the storage account is fixed silently
# (its fallback can only produce names Azure already rejects), and Cosmos says so out loud.
run "storage_uppercase_is_normalised_and_cosmos_objects" {
  command = plan

  variables {
    project_name = "AlethiaNL"
    environment  = "Prod"
  }

  expect_failures = [check.cosmos_account_name_within_limit]

  assert {
    condition     = local.azure_storage_account_name == "alethianlprodst"
    error_message = "Uppercase must be normalised out of a storage account name, got ${local.azure_storage_account_name}."
  }
}

# Truncation must not collide. These two environments share their first 16 characters exactly, so
# under plain truncation both would resolve to ONE storage account — two environments writing into
# each other's blobs.
run "storage_two_environments_sharing_a_prefix_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-a"
  }

  assert {
    condition     = local.azure_storage_account_name == "alethianlproduct5fe65e1e"
    error_message = "Expected the -a environment's own digest, got ${local.azure_storage_account_name}."
  }
}

run "storage_two_environments_sharing_a_prefix_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-b"
  }

  assert {
    condition     = local.azure_storage_account_name == "alethianlproduct510a341e"
    error_message = "Expected the -b environment's own digest (distinct from -a's 5fe65e1e), got ${local.azure_storage_account_name}."
  }
}

################################################################################
# 4b. Cosmos DB account — 3-44
################################################################################

run "cosmos_a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-abcde"
  }

  assert {
    condition     = local.azure_cosmos_account_name == "alethia-nl-production-eu-west-1-abcde-cosmos" && length(local.azure_cosmos_account_name) == 44
    error_message = "A Cosmos account name of exactly 44 characters must be kept verbatim, got ${local.azure_cosmos_account_name} (${length(local.azure_cosmos_account_name)} chars)."
  }
}

run "cosmos_a_name_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-abcdef"
  }

  assert {
    condition     = local.azure_cosmos_account_name == "alethia-nl-production-eu-west-1-abcd-4379168" && length(local.azure_cosmos_account_name) == 44
    error_message = "A 45-character Cosmos account name must fall back to truncate-plus-digest, got ${local.azure_cosmos_account_name}."
  }
}

run "cosmos_a_long_name_falls_back_inside_the_cap" {
  command = plan

  variables {
    project_name = "alethia-labs-northwest-region-group"
    environment  = "production"
  }

  assert {
    condition     = local.azure_cosmos_account_name == "alethia-labs-northwest-region-group-4ad1cc0"
    error_message = "Cosmos: expected the truncate-plus-digest form, got ${local.azure_cosmos_account_name}."
  }
}

################################################################################
# 4c. ACR, Service Bus, Managed Redis and the WAF policy
#
# All four have real headroom, so the case that matters for them is the fallback landing inside its
# cap when a customer name finally is long enough. This input overflows every one of them at once.
#
# The Managed Redis expectation is the load-bearing one: 60, not the 63 that Microsoft's
# naming-rules table gives for the RETIRED Microsoft.Cache/Redis. This template creates
# Microsoft.Cache/redisEnterprise, whose ARM schema states ^(?=.{1,60}$)…, so budgeting against 63
# would have been three characters wrong in the direction that fails an apply.
################################################################################

run "every_remaining_name_falls_back_inside_its_own_cap" {
  command = plan

  variables {
    project_name = "alethia-labs-northwest-region-group-extended"
    environment  = "production-eu-west-1-with-a-very-long-suffix"
  }

  assert {
    condition     = local.azure_acr_name == "acralethialabsnorthwestregiongroupextendede37e79ef" && length(local.azure_acr_name) == 50
    error_message = "ACR: expected a 50-char truncate-plus-digest, got ${local.azure_acr_name} (${length(local.azure_acr_name)} chars)."
  }

  assert {
    condition     = local.azure_service_bus_name == "sb-alethia-labs-northwest-region-group-ext-cce6b34" && length(local.azure_service_bus_name) == 50
    error_message = "Service Bus: expected a 50-char truncate-plus-digest, got ${local.azure_service_bus_name} (${length(local.azure_service_bus_name)} chars)."
  }

  assert {
    condition     = local.azure_cache_name == "alethia-labs-northwest-region-group-extended-product-ef493a7" && length(local.azure_cache_name) == 60
    error_message = "Managed Redis: expected a 60-char truncate-plus-digest, got ${local.azure_cache_name} (${length(local.azure_cache_name)} chars)."
  }

  assert {
    condition     = local.azure_waf_policy_name == "alethia-labs-northwest-region-group-extended-production-eu-west-1-with-a-8414ac5" && length(local.azure_waf_policy_name) == 80
    error_message = "WAF policy: expected an 80-char truncate-plus-digest, got ${local.azure_waf_policy_name} (${length(local.azure_waf_policy_name)} chars)."
  }

  # The resource group, which this suite FOUND. An input long enough to overflow the four names
  # above overflowed `rg-<project_name>-<environment>` first, and azurerm refused the plan with
  # "name may not exceed 90 characters in length" — before a single resource existed. It had no
  # budget either; now it does.
  assert {
    condition     = local.azure_resource_group_name == "rg-alethia-labs-northwest-region-group-extended-production-eu-west-1-with-a-very-l-0b3d0d5" && length(local.azure_resource_group_name) == 90
    error_message = "Resource group: expected a 90-char truncate-plus-digest, got ${local.azure_resource_group_name} (${length(local.azure_resource_group_name)} chars)."
  }
}

################################################################################
# 5. The AKS node resource group — 80 characters, derived by AZURE (#1921)
#
# The leak in the #1886/#1905 length-budget class that this file could not have caught, because
# until the derivation existed the string was never in the configuration: `modules/aks/main.tf` set
# every AKS argument except `node_resource_group`, so Azure composed
# "MC_<resource_group>_<cluster_name>_<location>" server-side. The e2e nightly hit it the only way
# it could — as a 400 from ARM, 489 seconds into `tofu apply`, with the cluster half-created:
#
#   creating Kubernetes Cluster ...: 400 InvalidParameter: "The length of the node resource group
#   name is too long. The maximum length is 80 and the length of the value provided is 82."
#
# So what is pinned here is the same property as everywhere else in this file, with one addition
# that only applies to this name: `node_resource_group` is ForceNew. A derivation that does not
# reproduce Azure's own form byte for byte would not merely rename something — it would REPLACE
# every AKS cluster in existence on the next apply. The verbatim cases below are that guarantee.
################################################################################

# Azure's own composition, reproduced exactly. This is the no-op case and it is the common one.
run "node_rg_reproduces_azures_own_form_when_it_fits" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod"
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-prod_aks-weu-prod-alethia_westeurope"
    error_message = "A node resource group that fits must reproduce Azure's own MC_<rg>_<cluster>_<location> form byte for byte — anything else REPLACES the cluster. Got ${local.azure_aks_node_resource_group}."
  }
}

# The exact boundary. 80 is legal, so it must NOT fall back: an off-by-one here replaces every
# cluster sitting exactly on the cap.
run "node_rg_a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-w1"
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-nl-production-eu-w1_aks-weu-production-eu-w1-alethia-nl_westeurope" && length(local.azure_aks_node_resource_group) == 80
    error_message = "A node resource group of exactly 80 characters must be kept verbatim, got ${local.azure_aks_node_resource_group} (${length(local.azure_aks_node_resource_group)} chars)."
  }
}

# THE case from #1921 — run 30882660761 of the e2e nightly, byte for byte. The first assertion pins
# the REPRODUCTION: the composition Azure would have made is 82 characters, exactly the number ARM
# reported. The second is the fix. Without the budget the second fails at 82 while the first still
# passes, which is what makes this pair a regression test rather than a restatement.
run "node_rg_the_e2e_nightly_shape_lands_inside_the_cap" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30882660761-1"
    location     = "germanywestcentral"
  }

  assert {
    condition     = local.azure_aks_node_resource_group_full == "MC_rg-alethia-nl-30882660761-1_aks-gwc-30882660761-1-alethia-nl_germanywestcentral" && length(local.azure_aks_node_resource_group_full) == 82
    error_message = "The e2e nightly must still reproduce the 82-character composition ARM refused; got ${local.azure_aks_node_resource_group_full} (${length(local.azure_aks_node_resource_group_full)} chars). If this changed, the regression it guards has moved."
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-nl-30882660761-1_aks-gwc-30882660761-1-alethia-nl_germanyw_b01a9ca" && length(local.azure_aks_node_resource_group) == 80
    error_message = "NAMING-002 produced ${local.azure_aks_node_resource_group} (${length(local.azure_aks_node_resource_group)} chars) — AKS caps the node resource group at 80, and rejects it at APPLY, not at plan."
  }
}

# Two consecutive attempts of the same nightly run. They share their first 72 characters, so under
# plain truncation both clusters would claim ONE node resource group — and the second apply would
# adopt the first cluster's VMSS, NICs and load balancer. Worse than the overflow it replaced.
run "node_rg_two_clusters_sharing_a_prefix_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30882660761-1"
    location     = "germanywestcentral"
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-nl-30882660761-1_aks-gwc-30882660761-1-alethia-nl_germanyw_b01a9ca"
    error_message = "Expected the -1 attempt's own digest, got ${local.azure_aks_node_resource_group}."
  }
}

run "node_rg_two_clusters_sharing_a_prefix_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30882660761-2"
    location     = "germanywestcentral"
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-nl-30882660761-2_aks-gwc-30882660761-2-alethia-nl_germanyw_8ed7a68"
    error_message = "Expected the -2 attempt's own digest (distinct from -1's b01a9ca), got ${local.azure_aks_node_resource_group}."
  }
}

# The separator here is an underscore, so a truncation landing on one would leave "__" — which is
# why the strip covers `_` as well as `-` and `.`. This input truncates at exactly that point: 71
# characters survive the strip, so the result is 79 rather than 80.
run "node_rg_a_truncation_landing_on_a_separator_trims_it" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-w1x"
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-nl-production-eu-w1x_aks-weu-production-eu-w1x-alethia-nl_bce9384" && length(local.azure_aks_node_resource_group) == 79
    error_message = "A truncation landing on the underscore separator must trim it rather than double it, got ${local.azure_aks_node_resource_group} (${length(local.azure_aks_node_resource_group)} chars)."
  }
}

# The longest input the generators permit, and the case a per-name budget cannot see: the parent
# resource group is ALREADY at its own 90-character fallback and the cluster name is 96 characters,
# both legal — and the composition is 202. Every other name on this surface is inside its cap here
# (asserted in section 4c above); this one is two and a half times over.
run "node_rg_the_longest_realistic_input_lands_inside_the_cap" {
  command = plan

  variables {
    project_name = "alethia-labs-northwest-region-group-extended"
    environment  = "production-eu-west-1-with-a-very-long-suffix"
  }

  assert {
    condition     = length(local.azure_aks_node_resource_group_full) == 202
    error_message = "Expected the composed form to be 202 chars at the longest realistic input, got ${length(local.azure_aks_node_resource_group_full)}."
  }

  assert {
    condition     = local.azure_aks_node_resource_group == "MC_rg-alethia-labs-northwest-region-group-extended-production-eu-west-1_cb46f00" && length(local.azure_aks_node_resource_group) <= 80
    error_message = "The longest realistic input must land inside 80, got ${local.azure_aks_node_resource_group} (${length(local.azure_aks_node_resource_group)} chars)."
  }
}
