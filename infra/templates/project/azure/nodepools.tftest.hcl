# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #5535 — what the AKS template BUILDS from node_labels, node_taints and extra_node_pools, proven
# against the plan. nodepool_contract.tftest.hcl proves the contract (its refusals and its render);
# this file proves the Azure pools: keyed by name, sized on their own, tainted in AKS's spelling,
# isolated like the default pool, and the existing pools untouched when nothing is set.
#
# Every assertion reads a PLANNED pool through module.aks[0].node_pools (modules/aks/outputs.tf),
# never the local that fed it. The one exception is node_labels_argument: a mocked plan reads a null
# node_labels back as {}, so the default-render run asserts the argument itself is null.
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
  provision_aks   = true
}


run "aks_nodepools_nothing_set_renders_the_existing_pools_unchanged" {
  command = plan

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5", "Standard_E4s_v5"]
    aks_spot_enabled   = true
  }

  assert {
    condition     = jsonencode(sort(keys(module.aks[0].node_pools))) == jsonencode(["default", "pool1", "pool2", "spot"])
    error_message = "With nothing set the cluster must have exactly the pools it had before: default, pool1..N from aks_instance_types, and spot."
  }

  assert {
    condition     = module.aks[0].node_labels_argument == null
    error_message = "With node_labels empty the default and positional pools must render NO node_labels argument (null, not {}), as before #5535."
  }

  assert {
    condition = alltrue([
      for name, vm in { pool1 = "Standard_D8s_v5", pool2 = "Standard_E4s_v5" } :
      module.aks[0].node_pools[name].vm_size == vm &&
      module.aks[0].node_pools[name].min_count == 1 &&
      module.aks[0].node_pools[name].max_count == 5 &&
      module.aks[0].node_pools[name].node_count == 2 &&
      module.aks[0].node_pools[name].priority == null &&
      module.aks[0].node_pools[name].node_taints == null
    ])
    error_message = "The positional pools must keep their names, VM sizes and the shared aks_node_* sizes, and carry no priority and no taints."
  }

  assert {
    condition     = module.aks[0].node_pools["spot"].priority == "Spot" && module.aks[0].node_pools["spot"].node_taints == null
    error_message = "The Spot pool must stay a Spot pool with no node_taints of its own."
  }

  assert {
    condition     = length(terraform_data.aks_nodepool_guard) == 0
    error_message = "With nothing set no node-pool guard may be planned: the plan must not gain a resource."
  }
}

run "aks_nodepools_extra_node_pools_are_keyed_by_name_with_their_own_sizes_and_taints" {
  command = plan

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5"]
    node_taints = [
      { key = "dedicated", value = "batch", effect = "NoSchedule" },
    ]
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4ps_v5"
        min_size      = 1
        max_size      = 4
        desired_size  = 2
        arch          = "arm64"
        taints        = [{ key = "example.com/batch", effect = "PreferNoSchedule" }]
      },
      {
        name          = "gpu"
        instance_type = "Standard_NC4as_T4_v3"
        min_size      = 0
        max_size      = 3
        capacity_type = "spot"
        labels        = { accelerator = "t4" }
        taints        = [{ key = "gpu", value = "true", effect = "NoSchedule" }]
      },
    ]
  }

  assert {
    condition     = jsonencode(sort(keys(module.aks[0].node_pools))) == jsonencode(["batch", "default", "gpu", "pool1"])
    error_message = "Each extra_node_pools entry must be its own pool named for its entry, beside the default and positional pools."
  }

  assert {
    condition = (
      module.aks[0].node_pools["batch"].vm_size == "Standard_D4ps_v5" &&
      module.aks[0].node_pools["batch"].min_count == 1 &&
      module.aks[0].node_pools["batch"].max_count == 4 &&
      module.aks[0].node_pools["batch"].node_count == 2 &&
      module.aks[0].node_pools["batch"].mode == "User" &&
      module.aks[0].node_pools["batch"].priority == null
    )
    error_message = "The batch pool must have its own VM size and sizes (1/4, desired 2), mode User and no Spot priority."
  }

  assert {
    condition = (
      module.aks[0].node_pools["gpu"].vm_size == "Standard_NC4as_T4_v3" &&
      module.aks[0].node_pools["gpu"].min_count == 0 &&
      module.aks[0].node_pools["gpu"].max_count == 3 &&
      module.aks[0].node_pools["gpu"].node_count == 0 &&
      module.aks[0].node_pools["gpu"].mode == "User" &&
      module.aks[0].node_pools["gpu"].priority == "Spot"
    )
    error_message = "The gpu pool must have its own VM size and sizes (0/3, desired defaulting to min_size), mode User and priority Spot."
  }

  assert {
    condition     = jsonencode(module.aks[0].node_pools["batch"].node_taints) == jsonencode(["dedicated=batch:NoSchedule", "example.com/batch:PreferNoSchedule", "alethia.io/arch=arm64:NoSchedule"])
    error_message = "The batch pool's taints must be node_taints, then its own (key:Effect when it has no value), then the arm64 platform taint, in AKS's key=value:Effect spelling."
  }

  assert {
    condition     = jsonencode(module.aks[0].node_pools["gpu"].node_taints) == jsonencode(["dedicated=batch:NoSchedule", "gpu=true:NoSchedule", "kubernetes.azure.com/scalesetpriority=spot:NoSchedule"])
    error_message = "The gpu Spot pool's taints must be node_taints, its own, and the Spot taint AKS puts on its nodes, which azurerm requires a Spot pool to declare."
  }

  assert {
    condition     = jsonencode(module.aks[0].node_pools["gpu"].node_labels) == jsonencode({ "accelerator" = "t4", "alethia.io/pool" = "gpu", "kubernetes.azure.com/scalesetpriority" = "spot" })
    error_message = "The gpu pool's labels must be its own, alethia.io/pool=gpu, and the Spot label AKS puts on its nodes."
  }

  assert {
    condition     = module.aks[0].node_pools["pool1"].vm_size == "Standard_D8s_v5" && module.aks[0].node_pools["pool1"].min_count == 1 && module.aks[0].node_pools["pool1"].max_count == 5 && module.aks[0].node_pools["pool1"].node_taints == null
    error_message = "Adding named pools must leave the positional pool1 as it was, and node_taints must not reach it."
  }
}

run "aks_nodepools_node_labels_reach_every_pool" {
  command = plan

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5"]
    aks_spot_enabled   = true
    node_labels        = { team = "payments" }
    extra_node_pools   = [{ name = "batch", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  assert {
    condition     = alltrue([for name in ["default", "pool1", "spot", "batch"] : module.aks[0].node_pools[name].node_labels["team"] == "payments"])
    error_message = "node_labels must reach the default pool, the positional pools, the Spot pool and every named pool."
  }

  assert {
    condition     = module.aks[0].node_pools["spot"].node_labels["kubernetes.azure.com/scalesetpriority"] == "spot"
    error_message = "Once node_labels is set, the Spot pool must declare the Spot label beside them, as azurerm requires of a Spot pool."
  }

  assert {
    condition     = jsonencode(module.aks[0].node_labels_argument) == jsonencode({ team = "payments" })
    error_message = "The default and positional pools must render node_labels as given."
  }
}

run "aks_nodepools_named_pools_keep_the_default_pools_isolation" {
  command = plan

  variables {
    aks_os_disk_type = "Ephemeral"
    aks_disk_size_gb = 128
    extra_node_pools = [
      { name = "batch", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "cheap", instance_type = "Standard_D4s_v5", min_size = 0, max_size = 2, capacity_type = "spot" },
    ]
  }

  assert {
    condition = alltrue([for name in ["batch", "cheap"] :
      module.aks[0].node_pools[name].vnet_subnet_id == module.aks[0].node_pools["default"].vnet_subnet_id &&
      module.aks[0].node_pools[name].os_disk_type == "Ephemeral" &&
      module.aks[0].node_pools[name].os_disk_type == module.aks[0].node_pools["default"].os_disk_type &&
      module.aks[0].node_pools[name].os_disk_size_gb == 128 &&
      module.aks[0].node_pools[name].os_disk_size_gb == module.aks[0].node_pools["default"].os_disk_size_gb &&
      module.aks[0].node_pools[name].max_pods == module.aks[0].node_pools["default"].max_pods
    ])
    error_message = "A named pool, Spot or not, must sit in the default pool's subnet with its OS disk type and size and max_pods: a pool may not be cheaper because it is less isolated."
  }
}

run "aks_nodepools_refuses_an_arm64_pool_on_an_x86_size" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2, arch = "arm64" }]
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_refuses_an_amd64_pool_on_an_arm64_size" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "Standard_D4ps_v5", min_size = 1, max_size = 2 }]
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_refuses_another_clouds_instance_type" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "m7g.large", min_size = 1, max_size = 2 }]
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_refuses_node_settings_without_a_cluster" {
  command = plan

  variables {
    provision_aks = false
    node_labels   = { team = "payments" }
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_accepts_the_arm64_sizes" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "altra", instance_type = "Standard_D4ps_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "altrad", instance_type = "Standard_E8pds_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "altral", instance_type = "Standard_D2pls_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "cobalt", instance_type = "Standard_D4plds_v6", min_size = 1, max_size = 2, arch = "arm64" },
    ]
  }

  assert {
    condition     = length(terraform_data.aks_nodepool_guard) == 1 && alltrue([for name in ["altra", "altrad", "altral", "cobalt"] : contains(module.aks[0].node_pools[name].node_taints, "alethia.io/arch=arm64:NoSchedule")])
    error_message = "Every Arm64 D/E size, v5 and v6, must plan as an arm64 pool carrying the alethia.io/arch taint."
  }
}
