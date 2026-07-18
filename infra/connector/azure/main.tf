# Alethia Azure connector — Terraform parity with alethia-azure-setup.sh (keyless, customer-side).
#
# Azure federation is implemented by Entra ID, but there is NO platform app to register and NO
# client secret anywhere. This module creates, in YOUR subscription, a User-Assigned Managed
# Identity (a plain ARM resource — no App Registration, no directory-admin rights) with a
# federated-identity credential that trusts the Alethia OIDC issuer. Alethia authenticates AS
# that identity by presenting a short-lived assertion its issuer mints (subject
# `alethia-connector`, audience `api://AzureADTokenExchange`). You grant the identity a
# least-privilege role on the subscription and paste three public ids back — parity with the
# GCP Workload Identity Federation model (no platform Entra app, no `ALETHIA_AZURE_CLIENT_ID`).
#
# Usage:
#   terraform init && terraform apply \
#     -var "subscription_id=YOUR_SUBSCRIPTION_ID" \
#     -var "issuer_url=https://alethialabs.io/api/oidc"   # your Alethia console's issuer
#   terraform output            # tenant_id / subscription_id / client_id

terraform {
  required_providers {
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

variable "subscription_id" {
  type        = string
  description = "The Azure subscription Alethia will provision into."
}

variable "issuer_url" {
  type        = string
  description = "The Alethia OIDC issuer URL the managed identity federates off (your console's /api/oidc)."
  default     = "https://alethialabs.io/api/oidc"
}

variable "location" {
  type        = string
  description = "Azure region for the connector resource group + managed identity (metadata only; not where clusters go)."
  default     = "eastus"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group that holds the Alethia connector managed identity."
  default     = "alethia-connector"
}

# The fixed workload subject + audience the Alethia issuer mints. MUST equal WORKLOAD_SUBJECT
# (lib/oidc/issuer.ts) and AZURE_TOKEN_AUDIENCE (lib/cloud-providers/session/azure.ts).
locals {
  workload_subject = "alethia-connector"
  token_audience   = "api://AzureADTokenExchange"
}

data "azurerm_subscription" "current" {}

# Resource group holding the connector identity. Metadata only — clusters land in their own groups.
resource "azurerm_resource_group" "alethia" {
  name     = var.resource_group_name
  location = var.location
}

# The customer-owned identity Alethia authenticates AS. A User-Assigned Managed Identity — created
# in YOUR subscription with no App Registration and no directory write. Its client id is per-customer
# (returned below), NOT a shared platform app id.
resource "azurerm_user_assigned_identity" "alethia" {
  name                = "alethia-provisioner"
  resource_group_name = azurerm_resource_group.alethia.name
  location            = azurerm_resource_group.alethia.location
}

# Federated-identity credential: trusts the Alethia issuer for the fixed subject + audience. This is
# what lets Alethia's minted assertion be exchanged for an Azure token as this identity — keyless.
resource "azurerm_federated_identity_credential" "alethia" {
  name                = "alethia-connector"
  resource_group_name = azurerm_resource_group.alethia.name
  parent_id           = azurerm_user_assigned_identity.alethia.id
  audience            = [local.token_audience]
  issuer              = var.issuer_url
  subject             = local.workload_subject
}

# Least-privilege custom role — replaces subscription Contributor. Enumerates only the actions the
# Alethia project templates need. NOTE: this also FIXES a latent gap — Contributor excludes
# Microsoft.Authorization/roleAssignments/write, which the templates require (the external-dns DNS
# Zone Contributor assignment), so pure Contributor could not actually provision an AKS project. We
# add that write but CONSTRAIN it (below) to a single role.
resource "azurerm_role_definition" "alethia_provisioner" {
  name        = "Alethia Provisioner"
  scope       = data.azurerm_subscription.current.id
  description = "Least-privilege provisioning role for Alethia — scoped to the services Alethia creates."

  permissions {
    actions = [
      # Resource groups + subscription reads + resource-provider registration.
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/write",
      "Microsoft.Resources/subscriptions/resourceGroups/delete",
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/resources/read",
      "Microsoft.Resources/deployments/*",
      "*/register/action",
      # AKS (incl. kubeconfig list for the kubernetes/helm providers).
      "Microsoft.ContainerService/managedClusters/*",
      "Microsoft.ContainerService/locations/*/read",
      # Networking used by the templates.
      "Microsoft.Network/virtualNetworks/*",
      "Microsoft.Network/networkSecurityGroups/*",
      "Microsoft.Network/publicIPAddresses/*",
      "Microsoft.Network/natGateways/*",
      "Microsoft.Network/routeTables/*",
      "Microsoft.Network/dnsZones/*",
      "Microsoft.Network/privateDnsZones/*",
      "Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/*",
      # Data + registry + messaging + storage.
      "Microsoft.DBforPostgreSQL/flexibleServers/*",
      "Microsoft.Cache/redis/*",
      "Microsoft.ContainerRegistry/registries/*",
      "Microsoft.Storage/storageAccounts/*",
      "Microsoft.ServiceBus/namespaces/*",
      "Microsoft.DocumentDB/databaseAccounts/*",
      # Managed identity for workload identity.
      "Microsoft.ManagedIdentity/userAssignedIdentities/*",
      # Key Vault control plane + soft-delete purge (purge_protection reuses names).
      "Microsoft.KeyVault/vaults/*",
      "Microsoft.KeyVault/locations/deletedVaults/purge/action",
      "Microsoft.KeyVault/locations/operationResults/read",
      # Role assignments — needed for the external-dns identity; CONSTRAINED below.
      "Microsoft.Authorization/roleAssignments/read",
      "Microsoft.Authorization/roleAssignments/write",
      "Microsoft.Authorization/roleAssignments/delete",
      "Microsoft.Authorization/roleDefinitions/read",
    ]
    # Key Vault with RBAC authorization → secret writes are data-plane.
    data_actions = [
      "Microsoft.KeyVault/vaults/secrets/*",
    ]
    not_actions = []
  }

  assignable_scopes = [data.azurerm_subscription.current.id]
}

# Built-in, least-privilege roles the Alethia project templates assign — the ONLY roles the provisioner
# may create/delete assignments for. Owner / Contributor / User Access Administrator are deliberately
# excluded, so there is no self-escalation path. A real apply proved the earlier DNS-only set too narrow
# (Key Vault + AKS assignments 403'd — #776).
locals {
  provisioner_assignable_role_ids = join(", ", [
    "befefa01-2a29-4197-83a8-272ff33ce314", # DNS Zone Contributor (external-dns)
    "4633458b-17de-408a-b874-0445c86b69e6", # Key Vault Secrets User (external-secrets workload id)
    "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", # Key Vault Secrets Officer (provisioner seeds secrets)
    "b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b", # Azure Kubernetes Service RBAC Cluster Admin
  ])
}

# Assign the custom role to the managed identity, with an ABAC condition constraining roleAssignments
# write/delete to ONLY the least-privilege role set above. The connector can create the assignments the
# templates need — and nothing else (no self-grant of Owner). This is the escalation control.
resource "azurerm_role_assignment" "alethia_provisioner" {
  scope              = data.azurerm_subscription.current.id
  role_definition_id = azurerm_role_definition.alethia_provisioner.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.alethia.principal_id

  condition_version = "2.0"
  condition         = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.provisioner_assignable_role_ids}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.provisioner_assignable_role_ids}}
     )
    )
  EOT
}

output "tenant_id" {
  value       = data.azurerm_subscription.current.tenant_id
  description = "Paste this into the Alethia connect sheet as Tenant ID."
}

output "subscription_id" {
  value       = var.subscription_id
  description = "Paste this into the Alethia connect sheet as Subscription ID."
}

output "client_id" {
  value       = azurerm_user_assigned_identity.alethia.client_id
  description = "Paste this into the Alethia connect sheet as Client ID (the managed identity's application id)."
}
