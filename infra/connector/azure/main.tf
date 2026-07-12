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

# Least-privilege custom role — replaces subscription Contributor. Enumerates only the
# actions the Alethia project templates need. NOTE: this also FIXES a latent gap — Contributor
# excludes Microsoft.Authorization/roleAssignments/write, which the templates require (the
# external-dns DNS Zone Contributor assignment), so pure Contributor could not actually
# provision an AKS Project. We add that write but CONSTRAIN it (below) to a single role.
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

# DNS Zone Contributor built-in role — the only role the provisioner may assign (external-dns).
locals {
  dns_zone_contributor_role_id = "befefa01-2a29-4197-83a8-272ff33ce314"
}

# Assign the custom role, with an ABAC condition constraining roleAssignments write/delete to the
# single DNS Zone Contributor role. The connector can create the external-dns assignment the
# templates need — and nothing else (no self-grant of Owner). This is the escalation control.
resource "azurerm_role_assignment" "alethia_provisioner" {
  scope              = data.azurerm_subscription.current.id
  role_definition_id = azurerm_role_definition.alethia_provisioner.role_definition_resource_id
  principal_id       = azuread_service_principal.alethia.object_id

  condition_version = "2.0"
  condition         = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.dns_zone_contributor_role_id}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.dns_zone_contributor_role_id}}
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
