# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's `public_access` and `versioning` switches change the PLAN, in both
# directions, and that they change the thing they claim to change.
#
# Both cells failed the same way and neither was visible: the provider sent
# `container_access_type` into a module that declares `access_type`, and never looked at
# `Versioning` at all. Nothing errored — an object type discards what it does not name — so every
# container was created private and unversioned whichever way the switches were set.
#
# A wiring check cannot catch that class of bug on its own, and it cannot catch the next one either:
# it asks whether a resource argument reads a name, never whether that argument implements the
# feature the label promises. A plan can. Both directions are asserted deliberately — a suite that
# only exercised the ON case would pass for a template that hardcoded the feature on.
#
# Providers are mocked, so this needs no credentials.

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-0000000000aa"
      subscription_id = "00000000-0000-0000-0000-000000000001"
      client_id       = "00000000-0000-0000-0000-0000000000bb"
      object_id       = "00000000-0000-0000-0000-0000000000cc"
    }
  }

  # Azure resource ids are PARSED by the provider before any API call, and the mock's generated
  # strings do not parse. None of these ids is under test; they only have to be well-formed.
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

  # checks_secrets.tf asserts the vault URI starts with https://, which a generated string is not.
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Storage/storageAccounts/mock" }
  }
}

mock_provider "azuread" {}
mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000001"
  location        = "westeurope"
  environment     = "production"
  project_name    = "alethia-nl"

  provision_aks          = false
  create_storage_account = true
}

################################################################################
# 1. Both switches OFF — the state every existing container is already in
################################################################################

run "a_private_unversioned_container_is_the_default_shape" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", access_type = "private", versioning_enabled = false },
    ]
  }

  assert {
    condition     = output.storage_container_access_types["assets"] == "private"
    error_message = "A container with public access off must plan container_access_type = \"private\", got ${output.storage_container_access_types["assets"]}."
  }

  assert {
    condition     = output.storage_blob_versioning_enabled == false
    error_message = "No container asked for versioning, so the account must plan versioning_enabled = false."
  }

  # The account-level permission must be as tight as the containers need. azurerm's own default is
  # `true`; leaving it there would have every project's account permit public blobs forever.
  assert {
    condition     = output.storage_allow_nested_items_to_be_public == false
    error_message = "With every container private the account must not permit public blobs."
  }
}

################################################################################
# 2. Public access ON
################################################################################

run "a_public_container_plans_blob_access_and_an_account_that_allows_it" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", access_type = "blob", versioning_enabled = false },
    ]
  }

  assert {
    condition     = output.storage_container_access_types["assets"] == "blob"
    error_message = "A container with public access on must plan container_access_type = \"blob\", got ${output.storage_container_access_types["assets"]}."
  }

  # Without this the container setting is accepted by the API and then behaves as private — a
  # switch that is carried, read, and still inert. The two arguments are one feature.
  assert {
    condition     = output.storage_allow_nested_items_to_be_public == true
    error_message = "A public container is inert unless the account permits nested public items."
  }

  # Versioning must not ride along with public access. Two switches, two answers.
  assert {
    condition     = output.storage_blob_versioning_enabled == false
    error_message = "Public access must not turn versioning on."
  }
}

################################################################################
# 3. Versioning ON — including the aggregation decision
################################################################################

run "a_versioned_container_turns_account_versioning_on" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", access_type = "private", versioning_enabled = true },
    ]
  }

  assert {
    condition     = output.storage_blob_versioning_enabled == true
    error_message = "A container asking for versioning must plan versioning_enabled = true on the account."
  }

  assert {
    condition     = output.storage_container_access_types["assets"] == "private"
    error_message = "Versioning must not turn public access on."
  }
}

# THE aggregation decision, pinned. Azure blob versioning is an ACCOUNT property and a project has
# exactly one account, so mixed per-bucket answers must collapse — and the direction is a choice.
# `anytrue` versions a bucket nobody asked to version, which costs storage and loses nothing;
# `alltrue` would silently ignore a user who asked for versioning and lose their data on the first
# overwrite. This run is what stops a future "surely alltrue is more correct" edit.
run "one_container_asking_for_versioning_is_enough" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", access_type = "private", versioning_enabled = false },
      { name = "backups", access_type = "private", versioning_enabled = true },
    ]
  }

  assert {
    condition     = output.storage_blob_versioning_enabled == true
    error_message = "anytrue, not alltrue: a single container asking for versioning must turn it on for the account."
  }
}

################################################################################
# 4. CORS origins reach the account (#5543)
################################################################################
# The Go provider emits `cors_origins` per container and modules/storage-account unions them into
# the account's one cors_rule — but the ROOT `storage_containers` type did not declare the
# attribute, and an object type discards what it does not name. So a value set on a bucket was
# dropped at the root, the module's optional() filled in [], and the account planned no CORS rule.
# Nothing errored. These runs set the value AT THE ROOT, which is the seam that dropped it.

run "a_container_cors_origin_reaches_the_account_cors_rule" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", cors_origins = ["https://app.example.com"] },
      { name = "logs" },
    ]
  }

  assert {
    condition     = module.storage_account[0].cors_rule != null
    error_message = "A container that allows an origin must plan a cors_rule on the storage account; the root storage_containers type dropped cors_origins."
  }

  assert {
    condition     = tolist(try(module.storage_account[0].cors_rule.allowed_origins, [])) == tolist(["https://app.example.com"])
    error_message = "The account's cors_rule must allow exactly the origin the container asked for."
  }

  # Allowing an origin must not widen what it may DO beyond the module's fixed method set.
  assert {
    condition     = toset(try(module.storage_account[0].cors_rule.allowed_methods, [])) == toset(["GET", "HEAD", "OPTIONS", "PUT", "POST"])
    error_message = "The cors_rule must carry the module's fixed method set, not \"*\"."
  }
}

# The default direction: no container names an origin, so no rule — an empty cors_rule is not "no
# CORS", it is a rule that matches nothing and churns the plan.
run "no_cors_origin_plans_no_cors_rule" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets" },
    ]
  }

  assert {
    condition     = module.storage_account[0].cors_rule == null
    error_message = "With no container allowing an origin the account must plan no cors_rule."
  }
}

# The aggregation decision, pinned as versioning's is above: CORS is an ACCOUNT property, so the
# per-container lists are UNIONED — deduplicated and sorted, so re-ordering buckets on the canvas
# does not produce a plan diff.
run "cors_origins_from_every_container_are_unioned_into_one_rule" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", cors_origins = ["https://b.example.com", "https://a.example.com"] },
      { name = "uploads", cors_origins = ["https://a.example.com", "https://c.example.com"] },
    ]
  }

  assert {
    condition     = tolist(try(module.storage_account[0].cors_rule.allowed_origins, [])) == tolist(["https://a.example.com", "https://b.example.com", "https://c.example.com"])
    error_message = "The account's one cors_rule must allow the sorted, de-duplicated union of every container's origins."
  }
}

################################################################################
# 5. Origins Azure would accept and no browser would ever match are refused at plan
################################################################################
# Azure matches the browser's Origin header against these strings exactly. Each of the three below
# is accepted by the API and then matches nothing, so CORS fails against a rule that exists.

run "a_cors_origin_with_a_path_is_refused" {
  command = plan

  variables {
    storage_containers = [{ name = "assets", cors_origins = ["https://app.example.com/upload"] }]
  }

  expect_failures = [var.storage_containers]
}

run "a_cors_origin_without_a_scheme_is_refused" {
  command = plan

  variables {
    storage_containers = [{ name = "assets", cors_origins = ["app.example.com"] }]
  }

  expect_failures = [var.storage_containers]
}

run "a_cors_origin_with_a_non_http_scheme_is_refused" {
  command = plan

  variables {
    storage_containers = [{ name = "assets", cors_origins = ["ftp://files.example.com"] }]
  }

  expect_failures = [var.storage_containers]
}

# The accepted shapes, so the refusals above cannot pass by refusing everything: a port, plain http
# (local development), and `*` — which on Azure opens the whole account, as the docs say.
run "a_port_plain_http_and_the_wildcard_are_accepted" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", cors_origins = ["http://localhost:3000", "https://app.example.com:8443"] },
      { name = "public", cors_origins = ["*"] },
    ]
  }

  assert {
    condition     = tolist(try(module.storage_account[0].cors_rule.allowed_origins, [])) == tolist(["*", "http://localhost:3000", "https://app.example.com:8443"])
    error_message = "A port, plain http and `*` are valid origins and must reach the account's cors_rule."
  }
}

################################################################################
# 6. Azure's 64-origin limit, counted over the UNION
################################################################################
# 40 + 40 origins, 16 of them shared: 64 distinct, which is exactly the limit and must plan.
run "sixty_four_distinct_origins_across_containers_plan" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", cors_origins = [for i in range(0, 40) : "https://o${i}.example.com"] },
      { name = "uploads", cors_origins = [for i in range(24, 64) : "https://o${i}.example.com"] },
    ]
  }

  assert {
    condition     = length(try(module.storage_account[0].cors_rule.allowed_origins, [])) == 64
    error_message = "64 distinct origins is Azure's limit, not over it, and must reach the account's rule."
  }
}

# One more distinct origin, split so that NO single container is over the limit: only the union is.
run "sixty_five_distinct_origins_across_containers_are_refused" {
  command = plan

  variables {
    storage_containers = [
      { name = "assets", cors_origins = [for i in range(0, 40) : "https://o${i}.example.com"] },
      { name = "uploads", cors_origins = [for i in range(24, 65) : "https://o${i}.example.com"] },
    ]
  }

  expect_failures = [var.storage_containers]
}
