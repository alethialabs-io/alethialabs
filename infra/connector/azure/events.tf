# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Alethia near-real-time asset-inventory event forwarder (Azure). An Event Grid system topic on the
# subscription emits resource-write/delete events; a Function App normalizes VNet/subnet changes into
# Alethia's NormalizedCloudEvent contract and POSTs them to the console ingester
# (/api/cloud-events/azure). Opt-in companion to the federated-identity connector; only normalized
# {kind, native_id, region, deleted} events leave the subscription — never credentials.
#
# NOTE: deploy/verify in a real Azure subscription. The console ingester + normalized contract are live;
# this is the in-subscription forwarder half.

# subscription_id / app_name / alethia_aws_account_id are declared in main.tf (same module).
variable "location" {
  type    = string
  default = "eastus"
}
variable "ingestion_url" {
  type        = string
  description = "Base URL of the Alethia console, e.g. https://app.alethialabs.io"
}
variable "ingestion_secret" {
  type      = string
  sensitive = true
}

resource "azurerm_resource_group" "forwarder" {
  name     = "alethia-events"
  location = var.location
}

resource "azurerm_storage_account" "forwarder" {
  name                     = "alethiaevents${substr(replace(var.subscription_id, "-", ""), 0, 12)}"
  resource_group_name      = azurerm_resource_group.forwarder.name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_service_plan" "forwarder" {
  name                = "alethia-events-plan"
  resource_group_name = azurerm_resource_group.forwarder.name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "Y1" # consumption
}

resource "azurerm_linux_function_app" "forwarder" {
  name                       = "alethia-asset-forwarder-${substr(replace(var.subscription_id, "-", ""), 0, 8)}"
  resource_group_name        = azurerm_resource_group.forwarder.name
  location                   = var.location
  service_plan_id            = azurerm_service_plan.forwarder.id
  storage_account_name       = azurerm_storage_account.forwarder.name
  storage_account_access_key = azurerm_storage_account.forwarder.primary_access_key
  site_config {
    application_stack {
      node_version = "20"
    }
  }
  app_settings = {
    INGESTION_URL         = var.ingestion_url
    INGESTION_SECRET      = var.ingestion_secret
    AZURE_SUBSCRIPTION_ID = var.subscription_id
    # The forwarder source (./forwarder) is deployed separately (func publish) or via WEBSITE_RUN_FROM_PACKAGE.
  }
}

# Subscription-scoped system topic for resource changes.
resource "azurerm_eventgrid_system_topic" "subscription" {
  name                   = "alethia-subscription-events"
  resource_group_name    = azurerm_resource_group.forwarder.name
  location               = "global"
  source_arm_resource_id = "/subscriptions/${var.subscription_id}"
  topic_type             = "Microsoft.Resources.Subscriptions"
}

# Route VNet/subnet write+delete events to the forwarder function.
resource "azurerm_eventgrid_system_topic_event_subscription" "networks" {
  name                = "alethia-networks"
  system_topic        = azurerm_eventgrid_system_topic.subscription.name
  resource_group_name = azurerm_resource_group.forwarder.name

  azure_function_endpoint {
    function_id = "${azurerm_linux_function_app.forwarder.id}/functions/forward"
  }

  included_event_types = [
    "Microsoft.Resources.ResourceWriteSuccess",
    "Microsoft.Resources.ResourceDeleteSuccess",
  ]
  # Narrow to virtualNetworks (subnets are child resources of the VNet write). The
  # resource-type token sits mid-subject, so EventGrid's subject_filter (begins/ends
  # only) can't match it — use an advanced_filter string_contains on the subject.
  advanced_filter {
    string_contains {
      key    = "subject"
      values = ["Microsoft.Network/virtualNetworks"]
    }
  }
}

# Route capability-affecting writes to the SAME forwarder (#978). A Microsoft.Quota quota change alters
# launch limits (→ capability_dirty axis=quota); a Microsoft.Features feature registration can change which
# regions/SKUs are available to the subscription (→ axis=regions). The forwarder classifies by subject and
# emits a capability_dirty signal that marks the capability catalog stale (the console re-enumerates keyless
# on the next sweep). (Role-assignment-delete / connection_health is added by #979.)
resource "azurerm_eventgrid_system_topic_event_subscription" "capabilities" {
  name                = "alethia-capabilities"
  system_topic        = azurerm_eventgrid_system_topic.subscription.name
  resource_group_name = azurerm_resource_group.forwarder.name

  azure_function_endpoint {
    function_id = "${azurerm_linux_function_app.forwarder.id}/functions/forward"
  }

  included_event_types = [
    "Microsoft.Resources.ResourceWriteSuccess",
  ]
  # Quota + feature-registration writes (mid-subject resource-type tokens → string_contains).
  advanced_filter {
    string_contains {
      key    = "subject"
      values = ["Microsoft.Quota", "Microsoft.Features"]
    }
  }
}
