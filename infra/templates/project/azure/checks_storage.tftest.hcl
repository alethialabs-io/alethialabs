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
