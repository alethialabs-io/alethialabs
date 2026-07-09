# Alethia Azure connector — Terraform parity with alethia-azure-setup.sh (keyless).
# Alethia registers ONE multi-tenant Entra app whose federated-identity credential trusts
# the Alethia OIDC issuer; the console + runner authenticate AS that app with a minted
# assertion — no client secret. This module does NOT create an app or a federated
# credential: it creates a service principal for Alethia's app in YOUR tenant and grants it
# Contributor on the subscription. Outputs the tenant/subscription ids to paste back.
#
# Usage:
#   terraform init && terraform apply \
#     -var "subscription_id=YOUR_SUBSCRIPTION_ID" \
#     -var "alethia_client_id=ALETHIA_APP_ID"      # shown in the connect dialog
#   terraform output            # tenant_id / subscription_id

terraform {
  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 2.47"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.80"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azuread" {}

variable "subscription_id" {
  type        = string
  description = "The Azure subscription Alethia will provision into."
}

variable "alethia_client_id" {
  type        = string
  description = "The Application (client) ID of Alethia's platform Entra app (shown in the connect dialog)."
}

data "azurerm_subscription" "current" {}

# Creates the service principal (enterprise application) for Alethia's multi-tenant app in
# THIS tenant. use_existing reconciles an already-present SP. No app object is registered
# locally — the app lives in Alethia's tenant.
resource "azuread_service_principal" "alethia" {
  client_id    = var.alethia_client_id
  use_existing = true
}

resource "azurerm_role_assignment" "alethia_contributor" {
  scope                = data.azurerm_subscription.current.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.alethia.object_id
}

output "tenant_id" {
  value       = data.azurerm_subscription.current.tenant_id
  description = "Paste this into the Alethia connect sheet as Tenant ID."
}

output "subscription_id" {
  value       = var.subscription_id
  description = "Paste this into the Alethia connect sheet as Subscription ID."
}
