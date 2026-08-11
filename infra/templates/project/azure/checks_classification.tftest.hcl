# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the sweep handle actually reaches RESOURCES, not just the merged local.
#
# checks_classification.tf asserts two properties of `local.azure_default_tags` — that base tags win
# the merge, and that no classification key is dropped. Both are true. Neither says a single resource
# ever received the map, and its own comment claims the second one "lands the mandatory
# alethia:project-id / alethia:environment-id sweep handles on the tagged resources". It does not.
#
# So the invariant was VACUOUSLY satisfied while three taggable resources carried no tags at all:
# both workload-identity user-assigned identities and the AKS secrets-encryption Key Vault key. All
# three showed up as phantom drift in #2358 (`+ tags = {}`), which is how they were noticed — but the
# real cost is that the nightly sweeper filters on `alethia:project-id`, so an interrupted run
# strands them, and the Key Vault key cannot even be purged afterwards because
# aks_secrets_encryption_enabled REQUIRES purge protection.
#
# A `check` block cannot carry this. checks_naming.tftest.hcl's header records why: `check` only ever
# WARNS, so #1873's guard existed and was useless while every azure nightly failed at plan. An
# assertion that must BLOCK belongs in a test.
#
# Providers are mocked, so this needs no credentials and runs on any PR. The mock block mirrors
# checks_cluster.tftest.hcl's, because reaching these three resources requires a full
# provision_aks = true plan.

mock_provider "azurerm" {
  # Azure resource IDs are PARSED by the provider before any API call, and the mock's generated
  # strings ("pRsp") parse into zero segments. Every id below is only required to be well-formed —
  # none of them is under test.
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
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/privateDnsZones/mock.private.mysql.database.azure.com" }
  }

  # Managed identities: the ids are parsed, and client_id / principal_id are validated as GUIDs
  # where they flow into role assignments and federated credentials.
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mock"
      client_id    = "00000000-0000-0000-0000-0000000000dd"
      principal_id = "00000000-0000-0000-0000-0000000000ee"
    }
  }

  # #2004: the AKS `key_management_service` block parses key_vault_key_id as a vault key URI, and
  # rejects the random string a mock otherwise generates.
  mock_resource "azurerm_key_vault_key" {
    defaults = {
      id                      = "https://mock-vault.vault.azure.net/keys/aks-secrets-encryption/00000000000000000000000000000001"
      resource_versionless_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock/keys/aks-secrets-encryption"
    }
  }

  # checks_secrets.tf asserts the vault URI starts with https://, which the generated string does not.
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
  }

  mock_resource "azurerm_public_ip" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/publicIPAddresses/mock" }
  }
  mock_resource "azurerm_application_gateway" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/applicationGateways/mock" }
  }
  mock_resource "azurerm_web_application_firewall_policy" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/applicationGatewayWebApplicationFirewallPolicies/mock" }
  }

  mock_resource "azurerm_mysql_flexible_server" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.DBforMySQL/flexibleServers/mock" }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/mock" }
  }

  # The mock leaves computed NESTED BLOCKS as empty lists, and modules/aks/outputs.tf indexes
  # kube_config[0] to reach the endpoint and the client certs.
  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id              = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.ContainerService/managedClusters/mock"
      oidc_issuer_url = "https://westeurope.oic.prod-aks.azure.com/00000000-0000-0000-0000-0000000000aa/mock/"
      kube_config = [{
        host                   = "https://mock.hcp.westeurope.azmk8s.io:443"
        client_certificate     = "bW9jaw=="
        client_key             = "bW9jaw=="
        cluster_ca_certificate = "bW9jaw=="
        username               = "clusterUser_mock"
        password               = "mock"
      }]
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

  # The sweep handles the nightly teardown filters on. Passing real-looking values is what makes
  # the assertions below meaningful: each is looked for BY VALUE, so a resource that silently drops
  # the map fails rather than matching an empty expectation.
  classification_tags = {
    "alethia:project-id"     = "e2e-31486339552-1"
    "alethia:environment-id" = "env-abc123"
  }
}

################################################################################
# The three resources the drift investigation found untagged (#2358)
################################################################################

# provision_aks gates all three counts, so this is the configuration in which they exist at all.
# key_vault_purge_protection_enabled is required by the secrets-encryption precondition — which is
# also precisely why an untagged key here is unrecoverable.
run "the_sweep_handle_reaches_every_taggable_workload_identity_resource" {
  command = plan

  variables {
    provision_aks                      = true
    aks_secrets_encryption_enabled     = true
    key_vault_purge_protection_enabled = true
  }

  assert {
    condition     = azurerm_user_assigned_identity.external_dns[0].tags["alethia:project-id"] == "e2e-31486339552-1"
    error_message = "The external_dns identity carries no alethia:project-id — the nightly sweeper filters on that tag, so an interrupted run strands it."
  }

  assert {
    condition     = azurerm_user_assigned_identity.external_secrets[0].tags["alethia:project-id"] == "e2e-31486339552-1"
    error_message = "The external_secrets identity carries no alethia:project-id — the nightly sweeper filters on that tag, so an interrupted run strands it."
  }

  # The expensive one. Purge protection is mandatory whenever this key exists, so an orphan the
  # sweeper cannot find cannot be purged either — it is stranded for the vault's retention window.
  assert {
    condition     = azurerm_key_vault_key.aks_secrets[0].tags["alethia:project-id"] == "e2e-31486339552-1"
    error_message = "The AKS secrets-encryption key carries no alethia:project-id. It is purge-protected by precondition, so a key the sweeper cannot find can never be cleaned up."
  }

  # Both handles, not only the one the sweeper uses — the second is what attributes cost.
  assert {
    condition = alltrue([
      for t in [
        azurerm_user_assigned_identity.external_dns[0].tags,
        azurerm_user_assigned_identity.external_secrets[0].tags,
        azurerm_key_vault_key.aks_secrets[0].tags,
      ] : t["alethia:environment-id"] == "env-abc123"
    ])
    error_message = "A taggable resource dropped alethia:environment-id; cost attribution is per environment."
  }

  # The platform base tags must ride along too — the same map, not a hand-rolled subset. A resource
  # tagged with only the sweep handles would satisfy every assertion above while still diverging
  # from every other resource in the template.
  assert {
    condition = alltrue([
      for t in [
        azurerm_user_assigned_identity.external_dns[0].tags,
        azurerm_user_assigned_identity.external_secrets[0].tags,
        azurerm_key_vault_key.aks_secrets[0].tags,
      ] : t["ManagedBy"] == "opentofu" && t["Service"] == "alethia-nl"
    ])
    error_message = "A taggable resource received a hand-rolled tag subset rather than local.azure_default_tags."
  }
}
