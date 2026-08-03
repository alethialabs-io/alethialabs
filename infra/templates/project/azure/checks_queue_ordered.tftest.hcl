# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that ordered delivery reaches azurerm_servicebus_queue.requires_session in BOTH positions,
# and that the Basic tier — which has no sessions at all — is refused at PLAN (#1812).
#
# Ordered delivery on Azure is a Service Bus SESSION. `requires_session` is ForceNew, so flipping it
# on an existing queue destroys the queue and its backlog; and once it is on, "client applications
# can no longer send or receive regular messages", so it breaks every existing producer and consumer
# too. That is why the unordered case is asserted first and asserted by VALUE: the switch must
# change nothing at all until a user sets it.
#
# The SKU gate is the second subject. Sessions need Standard or Premium, `service_bus_sku` is a free
# string variable that accepts "Basic", and the two inputs are independent — nothing else in the
# template stops a user picking both. Azure refuses the combination at APPLY, after the namespace
# exists; checks_queue.tf refuses it at plan.
#
# Providers are mocked, so this needs no credentials and runs on any PR. modules/**/*.tftest.hcl is
# silently never executed, which is why this lives at the root.

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-0000000000aa"
      subscription_id = "00000000-0000-0000-0000-000000000001"
      client_id       = "00000000-0000-0000-0000-0000000000bb"
      object_id       = "00000000-0000-0000-0000-0000000000cc"
    }
  }

  # Azure resource IDs are PARSED by the provider before any API call, and the mock's generated
  # strings parse into zero segments. Only the Service Bus namespace is under test; the rest are the
  # network the project always builds, and each is here because the provider refused to parse the
  # generated string, not because the test reads it.
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock" }
  }
  mock_resource "azurerm_servicebus_namespace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.ServiceBus/namespaces/mock" }
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
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/privateDnsZones/mock.private.mysql.database.azure.com" }
  }
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

  # Service Bus is the whole subject; the cluster is off so the graph stays small.
  provision_aks      = false
  create_service_bus = true
}

################################################################################
# The switch, in both positions
################################################################################

# The unordered case FIRST. `requires_session` is ForceNew, so a template that silently turned
# sessions on would replace every Service Bus queue in the fleet and drop its backlog. Asserting the
# value (not merely that the queue plans) is what catches that.
run "an_unordered_queue_requires_no_session" {
  command = plan

  variables {
    service_bus_queues = {
      orders = { requires_session = false }
    }
  }

  assert {
    condition     = module.service_bus[0].queue_requires_session["orders"] == false
    error_message = "With the switch off, requires_session must be false — it is ForceNew, so a wrong default replaces every existing queue."
  }

  assert {
    condition     = module.service_bus[0].queue_names["orders"] == "orders"
    error_message = "Ordered delivery must not change a queue's name on Azure. Got ${module.service_bus[0].queue_names["orders"]}."
  }
}

# A queue whose tfvars entry predates ordered delivery. `optional(bool, false)` on the module's
# object type is what makes this plan identically to the run above — the upgrade must move nothing.
run "a_queue_with_no_session_key_at_all_requires_no_session" {
  command = plan

  variables {
    service_bus_queues = {
      orders = {}
    }
  }

  assert {
    condition     = module.service_bus[0].queue_requires_session["orders"] == false
    error_message = "An absent requires_session key must default to false, not to whatever Azure would pick."
  }
}

# The other direction. Paired with the runs above: a template that hardcoded sessions on would pass
# this and fail those, and one that dropped the switch would pass those and fail this.
run "an_ordered_queue_requires_a_session" {
  command = plan

  variables {
    service_bus_queues = {
      orders = { requires_session = true }
    }
  }

  assert {
    condition     = module.service_bus[0].queue_requires_session["orders"] == true
    error_message = "Ordered delivery must reach azurerm_servicebus_queue.requires_session — sessions are the argument that implements it on Azure."
  }
}

################################################################################
# The Basic-tier gate
################################################################################

# Sessions on Standard must be ACCEPTED. Without this half the gate could be satisfied by refusing
# every ordered queue, and nobody would notice until it blocked the supported combination.
run "sessions_on_the_standard_tier_are_accepted" {
  command = plan

  variables {
    service_bus_sku = "Standard"
    service_bus_queues = {
      orders = { requires_session = true }
    }
  }

  assert {
    condition     = module.service_bus[0].queue_requires_session["orders"] == true
    error_message = "Standard supports sessions and must plan."
  }
}

# An ordered queue on the Basic tier must BLOCK. Azure rejects this at apply, once the namespace is
# already built — the same plan-clean / apply-broken shape the offer-parity work keeps finding. The
# `check` block states the violation in the plan output and the terraform_data precondition is what
# actually refuses; both are expected, so neither can be quietly dropped.
run "an_ordered_queue_on_the_basic_tier_blocks_the_plan" {
  command = plan

  variables {
    service_bus_sku = "Basic"
    service_bus_queues = {
      orders = { requires_session = true }
    }
  }

  expect_failures = [
    check.service_bus_sessions_need_standard_or_premium,
    terraform_data.service_bus_session_sku_guard,
  ]
}

# The Basic tier itself is fine — it is only Basic PLUS sessions that is refused. Without this run
# the gate could be a blanket ban on Basic and this suite would not notice.
run "the_basic_tier_without_sessions_still_plans" {
  command = plan

  variables {
    service_bus_sku = "Basic"
    service_bus_queues = {
      orders = { requires_session = false }
    }
  }

  assert {
    condition     = module.service_bus[0].queue_requires_session["orders"] == false
    error_message = "Basic without sessions is a supported combination and must plan."
  }
}
