# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #5530 — the Azure CUSTOMIZABILITY-PARITY top gaps, proven against the PLAN.
#
#   aks_log_retention_days          → workspace retention, oms_agent, DCR, control-plane diag setting
#   azure_db_log_exports            → a diagnostic setting on the Flexible Server
#   azure_db_database_flags         → one *_flexible_server_configuration per entry, per engine
#   storage_containers[*].cmek_enabled → key + identity + key-scoped grant + customer_managed_key
#   azure_cache_log_categories      → a diagnostic setting on the Managed Redis database
#
# Every assertion reads a PLANNED resource (or a module output read off one), never the local that
# fed it — an assertion on the local would pass for a template whose resource stopped reading it.
# Each knob is asserted in both directions: the first run pins that a project setting NONE of them
# plans none of the new resources, which is the "no new spend unless asked" contract.
#
# Providers are mocked, so this needs no credentials.

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

  # One mock for BOTH keys (the AKS KMS key and the storage CMEK key). `versionless_id` is what the
  # storage account's customer_managed_key reads and `resource_versionless_id` is the SCOPE of the
  # CMEK identity's grant; both are parsed by the provider, so neither may be a generated string.
  mock_resource "azurerm_key_vault_key" {
    defaults = {
      id                      = "https://mock.vault.azure.net/keys/mock/00000000000000000000000000000001"
      versionless_id          = "https://mock.vault.azure.net/keys/mock"
      resource_versionless_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock/keys/mock"
    }
  }

  # checks_secrets.tf asserts the vault URI starts with https://, which the generated string does not.
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
  }

  # Application Gateway lane. The gateway's `public_ip_address_id`, the gateway id (the SCOPE of
  # AGIC's Contributor grant) and the WAF policy id (bound as `firewall_policy_id`) are all PARSED
  # by the provider, so the generated strings will not do.
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
  # kube_config[0] to reach the endpoint and the client certs. The cluster id is also the SCOPE of
  # the runner's cluster-admin role assignment, which the provider parses as a resource id.
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

  # The ids this suite asserts BY VALUE — that the diagnostic settings and the oms_agent point at the
  # workspace the template created, and the cache setting at the Redis DATABASE.
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.OperationalInsights/workspaces/template-ws" }
  }
  mock_resource "azurerm_monitor_data_collection_rule" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Insights/dataCollectionRules/mock" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Storage/storageAccounts/mock" }
  }
  mock_resource "azurerm_managed_redis" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Cache/redisEnterprise/mock"
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

  # Every component the knobs attach to, so each default-off assertion is made where the knob COULD
  # have created something.
  provision_aks          = true
  create_azure_db        = true
  create_azure_cache     = true
  create_storage_account = true
  storage_containers     = [{ name = "assets" }]
}

################################################################################
# 0. Nothing set — none of the new resources exist (no new spend)
################################################################################

run "a_project_that_sets_no_knob_plans_none_of_them" {
  command = plan

  assert {
    condition = alltrue([
      length(azurerm_log_analytics_workspace.aks) == 0,
      length(azurerm_monitor_data_collection_rule.aks_container_insights) == 0,
      length(azurerm_monitor_data_collection_rule_association.aks_container_insights) == 0,
      length(azurerm_monitor_diagnostic_setting.aks_control_plane) == 0,
      length(azurerm_monitor_diagnostic_setting.azure_db) == 0,
      length(azurerm_monitor_diagnostic_setting.azure_cache) == 0,
      length(azurerm_postgresql_flexible_server_configuration.azure_db) == 0,
      length(azurerm_mysql_flexible_server_configuration.azure_db) == 0,
      length(azurerm_key_vault_key.storage_cmek) == 0,
      length(azurerm_user_assigned_identity.storage_cmek) == 0,
      length(azurerm_role_assignment.storage_cmek) == 0,
    ])
    error_message = "A project that set none of the #5530 knobs must plan none of their resources: a Log Analytics workspace and diagnostic settings bill per GB ingested."
  }

  assert {
    condition     = module.aks[0].oms_agent_workspace_id == null
    error_message = "With aks_log_retention_days unset the cluster must carry no oms_agent block."
  }

  assert {
    condition     = module.storage_account[0].customer_managed_key_id == null && module.storage_account[0].customer_managed_key_identity_id == null
    error_message = "With no container asking for CMEK the account must keep Microsoft-managed keys."
  }
}

# The provisioner's Crypto Officer grant is now shared with storage CMEK. With both features off it
# must still not exist — the count change in secrets-encryption.tf must not create it by default.
run "no_kms_and_no_cmek_plans_no_crypto_officer_grant" {
  command = plan

  variables {
    aks_secrets_encryption_enabled = false
  }

  assert {
    condition     = length(azurerm_role_assignment.provisioner_crypto_officer) == 0
    error_message = "With neither AKS KMS nor storage CMEK on, the provisioner must not be granted Key Vault Crypto Officer."
  }
}

################################################################################
# 1. aks_log_retention_days
################################################################################

run "aks_log_retention_creates_the_workspace_and_ships_control_plane_logs_to_it" {
  command = plan

  variables {
    aks_log_retention_days = 90
  }

  assert {
    condition     = azurerm_log_analytics_workspace.aks[0].retention_in_days == 90 && azurerm_log_analytics_workspace.aks[0].sku == "PerGB2018"
    error_message = "The workspace must be planned with retention_in_days = aks_log_retention_days (90) on PerGB2018."
  }

  assert {
    condition     = module.aks[0].oms_agent_workspace_id == azurerm_log_analytics_workspace.aks[0].id
    error_message = "The cluster's oms_agent must report to the workspace the template created."
  }

  assert {
    condition     = azurerm_monitor_diagnostic_setting.aks_control_plane[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.aks[0].id && azurerm_monitor_diagnostic_setting.aks_control_plane[0].target_resource_id == module.aks[0].cluster_id
    error_message = "The control-plane diagnostic setting must target the cluster and send to the template's workspace."
  }

  assert {
    condition     = toset([for l in azurerm_monitor_diagnostic_setting.aks_control_plane[0].enabled_log : l.category]) == toset(["kube-apiserver", "kube-audit-admin"])
    error_message = "The control-plane diagnostic setting must ship exactly kube-apiserver and kube-audit-admin."
  }

  assert {
    condition     = azurerm_monitor_data_collection_rule_association.aks_container_insights[0].target_resource_id == module.aks[0].cluster_id && azurerm_monitor_data_collection_rule_association.aks_container_insights[0].data_collection_rule_id == azurerm_monitor_data_collection_rule.aks_container_insights[0].id
    error_message = "MSI-mode Container Insights reads its configuration from a DCR associated with the cluster; the association must exist."
  }
}

run "aks_log_retention_without_a_cluster_creates_no_workspace" {
  command = plan

  variables {
    provision_aks          = false
    aks_log_retention_days = 90
  }

  assert {
    condition     = length(azurerm_log_analytics_workspace.aks) == 0 && length(azurerm_monitor_diagnostic_setting.aks_control_plane) == 0
    error_message = "With no cluster there are no control-plane logs, so no workspace may be billed for them."
  }
}

run "aks_log_retention_outside_the_log_analytics_range_is_refused" {
  command = plan

  variables {
    aks_log_retention_days = 7
  }

  expect_failures = [var.aks_log_retention_days]
}

################################################################################
# 2. azure_db_log_exports
################################################################################

run "db_log_exports_go_to_the_template_workspace_when_there_is_one" {
  command = plan

  variables {
    aks_log_retention_days = 30
    azure_db_log_exports   = ["PostgreSQLLogs", "PostgreSQLFlexSessions"]
  }

  assert {
    condition     = azurerm_monitor_diagnostic_setting.azure_db[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.aks[0].id
    error_message = "With a template workspace, the DB logs must go to it."
  }

  assert {
    condition     = azurerm_monitor_diagnostic_setting.azure_db[0].target_resource_id == module.azure_db[0].server_id
    error_message = "The DB diagnostic setting must target the provisioned Flexible Server."
  }

  assert {
    condition     = toset([for l in azurerm_monitor_diagnostic_setting.azure_db[0].enabled_log : l.category]) == toset(["PostgreSQLLogs", "PostgreSQLFlexSessions"])
    error_message = "The DB diagnostic setting must ship exactly the categories in azure_db_log_exports."
  }
}

run "db_log_exports_go_to_the_named_workspace_when_the_template_has_none" {
  command = plan

  variables {
    provision_aks             = false
    azure_db_engine           = "mysql"
    azure_db_engine_version   = "8.0.21"
    azure_db_log_exports      = ["MySqlSlowLogs"]
    azure_db_log_workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/logs/providers/Microsoft.OperationalInsights/workspaces/central"
  }

  assert {
    condition     = azurerm_monitor_diagnostic_setting.azure_db[0].log_analytics_workspace_id == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/logs/providers/Microsoft.OperationalInsights/workspaces/central"
    error_message = "Without a template workspace the DB logs must go to azure_db_log_workspace_id."
  }

  assert {
    condition     = toset([for l in azurerm_monitor_diagnostic_setting.azure_db[0].enabled_log : l.category]) == toset(["MySqlSlowLogs"])
    error_message = "A MySQL server must ship the MySQL category it was given."
  }
}

run "db_log_exports_with_nowhere_to_go_are_refused" {
  command = plan

  variables {
    provision_aks        = false
    azure_db_log_exports = ["PostgreSQLLogs"]
  }

  expect_failures = [terraform_data.azure_db_log_exports_guard]
}

run "db_log_exports_of_the_other_engine_are_refused" {
  command = plan

  variables {
    aks_log_retention_days = 30
    azure_db_log_exports   = ["MySqlSlowLogs"]
  }

  expect_failures = [terraform_data.azure_db_log_exports_guard]
}

run "an_unknown_db_log_category_is_refused" {
  command = plan

  variables {
    aks_log_retention_days = 30
    azure_db_log_exports   = ["postgresql-logs"]
  }

  expect_failures = [var.azure_db_log_exports]
}

################################################################################
# 3. azure_db_database_flags
################################################################################

run "db_flags_become_postgres_server_configurations" {
  command = plan

  variables {
    azure_db_database_flags = { max_connections = "200", log_min_duration_statement = "500" }
  }

  assert {
    condition = alltrue([
      azurerm_postgresql_flexible_server_configuration.azure_db["max_connections"].value == "200",
      azurerm_postgresql_flexible_server_configuration.azure_db["log_min_duration_statement"].value == "500",
      azurerm_postgresql_flexible_server_configuration.azure_db["max_connections"].server_id == module.azure_db[0].server_id,
      length(azurerm_mysql_flexible_server_configuration.azure_db) == 0,
    ])
    error_message = "Each flag must be one PostgreSQL server configuration on the provisioned server, and no MySQL configuration may be planned."
  }
}

run "db_flags_become_mysql_server_configurations_on_mysql" {
  command = plan

  variables {
    azure_db_engine         = "mysql"
    azure_db_engine_version = "8.0.21"
    azure_db_database_flags = { max_connections = "300" }
  }

  assert {
    condition = alltrue([
      azurerm_mysql_flexible_server_configuration.azure_db["max_connections"].value == "300",
      azurerm_mysql_flexible_server_configuration.azure_db["max_connections"].server_name == module.azure_db[0].server_name,
      length(azurerm_postgresql_flexible_server_configuration.azure_db) == 0,
    ])
    error_message = "On MySQL each flag must be one MySQL server configuration, and no PostgreSQL configuration may be planned."
  }
}

run "a_db_flag_that_can_turn_tls_off_is_refused" {
  command = plan

  variables {
    azure_db_database_flags = { require_secure_transport = "OFF" }
  }

  expect_failures = [var.azure_db_database_flags]
}

run "a_db_flag_that_can_lower_the_tls_floor_is_refused" {
  command = plan

  variables {
    azure_db_database_flags = { ssl_min_protocol_version = "TLSv1" }
  }

  expect_failures = [var.azure_db_database_flags]
}

################################################################################
# 4. Storage CMEK (storage_containers[*].cmek_enabled)
################################################################################

run "a_cmek_container_encrypts_the_account_with_a_key_scoped_identity" {
  command = plan

  variables {
    aks_secrets_encryption_enabled = false
    storage_containers = [
      { name = "assets" },
      { name = "ledger", cmek_enabled = true },
    ]
  }

  assert {
    condition     = toset(azurerm_key_vault_key.storage_cmek[0].key_opts) == toset(["wrapKey", "unwrapKey"]) && azurerm_key_vault_key.storage_cmek[0].key_vault_id == module.key_vault.vault_id
    error_message = "The CMEK key must live in the project's own Key Vault and permit only wrapKey/unwrapKey."
  }

  assert {
    condition = alltrue([
      azurerm_role_assignment.storage_cmek[0].role_definition_name == "Key Vault Crypto Service Encryption User",
      azurerm_role_assignment.storage_cmek[0].scope == azurerm_key_vault_key.storage_cmek[0].resource_versionless_id,
      azurerm_role_assignment.storage_cmek[0].principal_id == azurerm_user_assigned_identity.storage_cmek[0].principal_id,
    ])
    error_message = "The CMEK identity must hold only Key Vault Crypto Service Encryption User (data actions: keys/read + wrapKey + unwrapKey), scoped to the one key."
  }

  assert {
    condition     = module.storage_account[0].customer_managed_key_id == azurerm_key_vault_key.storage_cmek[0].versionless_id && module.storage_account[0].customer_managed_key_identity_id == azurerm_user_assigned_identity.storage_cmek[0].id
    error_message = "The planned account must carry customer_managed_key with the versionless key id and the CMEK identity."
  }

  # The provisioner needs Crypto Officer to CREATE the key even with AKS KMS off.
  assert {
    condition     = length(azurerm_role_assignment.provisioner_crypto_officer) == 1
    error_message = "Creating the CMEK key needs the provisioner's Key Vault Crypto Officer grant."
  }
}

run "cmek_without_purge_protection_is_refused" {
  command = plan

  variables {
    aks_secrets_encryption_enabled     = false
    key_vault_purge_protection_enabled = false
    storage_containers                 = [{ name = "ledger", cmek_enabled = true }]
  }

  expect_failures = [terraform_data.storage_cmek_purge_protection_guard]
}

################################################################################
# 5. azure_cache_log_categories
################################################################################

run "cache_logs_go_to_the_redis_database" {
  command = plan

  variables {
    aks_log_retention_days     = 30
    azure_cache_log_categories = ["ConnectionEvents"]
  }

  assert {
    condition = alltrue([
      azurerm_monitor_diagnostic_setting.azure_cache[0].target_resource_id == module.azure_cache[0].database_id,
      azurerm_monitor_diagnostic_setting.azure_cache[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.aks[0].id,
      toset([for l in azurerm_monitor_diagnostic_setting.azure_cache[0].enabled_log : l.category]) == toset(["ConnectionEvents"]),
    ])
    error_message = "The cache diagnostic setting must target the Managed Redis database and ship ConnectionEvents to the template workspace."
  }
}

run "cache_logs_with_nowhere_to_go_are_refused" {
  command = plan

  variables {
    azure_cache_log_categories = ["ConnectionEvents"]
  }

  expect_failures = [terraform_data.azure_cache_log_guard]
}

run "an_unknown_cache_log_category_is_refused" {
  command = plan

  variables {
    azure_cache_log_categories = ["AllMetrics"]
  }

  expect_failures = [var.azure_cache_log_categories]
}
