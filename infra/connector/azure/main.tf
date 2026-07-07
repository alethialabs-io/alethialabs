# Alethia Azure connector — Terraform parity with alethia-azure-setup.sh.
# Creates an Entra app registration + service principal, a federated identity
# credential trusting Alethia's AWS runners (OIDC issuer sts.amazonaws.com, subject =
# Alethia's AWS account id, audience api://AzureADTokenExchange), and a Contributor
# role assignment on the subscription. No client secrets are stored — Alethia
# authenticates via the federated credential. Outputs the tenant/client/subscription
# ids to paste back into the connect sheet.
#
# Usage:
#   terraform init && terraform apply -var "subscription_id=YOUR_SUBSCRIPTION_ID"
#   terraform output            # tenant_id / client_id / subscription_id

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

variable "alethia_aws_account_id" {
  type        = string
  default     = "270587882865"
  description = "The AWS account id of the Alethia platform (the federated-credential subject)."
}

variable "app_name" {
  type        = string
  default     = "alethia-provisioner"
  description = "Display name for the Entra app registration."
}

data "azurerm_subscription" "current" {}

resource "azuread_application" "alethia" {
  display_name = var.app_name
}

resource "azuread_service_principal" "alethia" {
  client_id = azuread_application.alethia.client_id
}

resource "azuread_application_federated_identity_credential" "alethia_aws" {
  application_id = azuread_application.alethia.id
  display_name   = "alethia-aws-federation"
  description    = "Trust Alethia AWS runners to authenticate as this app"
  issuer         = "https://sts.amazonaws.com"
  subject        = var.alethia_aws_account_id
  audiences      = ["api://AzureADTokenExchange"]
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

output "client_id" {
  value       = azuread_application.alethia.client_id
  description = "Paste this into the Alethia connect sheet as Client ID."
}

output "subscription_id" {
  value       = var.subscription_id
  description = "Paste this into the Alethia connect sheet as Subscription ID."
}
