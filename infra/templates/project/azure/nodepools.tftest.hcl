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
    condition     = module.aks[0].node_pools["spot"].priority == "Spot" && jsonencode(module.aks[0].node_pools["spot"].node_taints) == jsonencode(["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"])
    error_message = "The Spot pool must stay a Spot pool, and its only taint must be the one AKS puts on every Spot node, which azurerm requires a Spot pool to declare (#5578). None of the user's taints may reach it."
  }

  # #5578: every planned attribute of the four pools, pinned whole. Against dev the ONLY differences
  # are the three this change makes: rotation_name on every pool, and the Spot taint. node_count is
  # still the configured starting size, because ignore_changes affects only a pool that exists.
  assert {
    condition = jsonencode(module.aks[0].node_pools) == jsonencode({
      default = {
        eviction_policy = null, max_count = 5, max_pods = 110, min_count = 1, mode = "System", name = "default",
        node_count      = 2, node_labels = {}, node_taints = null, os_disk_size_gb = 100, os_disk_type = null,
        priority        = "Regular", rotation_name = "defaulc21f96", spot_max_price = null, vm_size = "Standard_D4s_v5",
        vnet_subnet_id  = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock"
      }
      pool1 = {
        eviction_policy = null, max_count = 5, max_pods = 110, min_count = 1, mode = null, name = "pool1",
        node_count      = 2, node_labels = {}, node_taints = null, os_disk_size_gb = 100, os_disk_type = null,
        priority        = null, rotation_name = "pool15934c3", spot_max_price = null, vm_size = "Standard_D8s_v5",
        vnet_subnet_id  = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock"
      }
      pool2 = {
        eviction_policy = null, max_count = 5, max_pods = 110, min_count = 1, mode = null, name = "pool2",
        node_count      = 2, node_labels = {}, node_taints = null, os_disk_size_gb = 100, os_disk_type = null,
        priority        = null, rotation_name = "pool239496f", spot_max_price = null, vm_size = "Standard_E4s_v5",
        vnet_subnet_id  = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock"
      }
      spot = {
        eviction_policy = "Delete", max_count = 3, max_pods = 110, min_count = 0, mode = null, name = "spot",
        node_count      = 0, node_labels = {}, node_taints = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"],
        os_disk_size_gb = 100, os_disk_type = null, priority = "Spot", rotation_name = "spotb2e189", spot_max_price = -1,
        vm_size         = "Standard_D4s_v5",
        vnet_subnet_id  = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock"
      }
    })
    error_message = "With nothing set the default, positional and Spot pools must plan exactly as before #5578 except for a rotation pool name on each and the Spot taint on the Spot pool."
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
    condition     = jsonencode(module.aks[0].node_pools["spot"].node_taints) == jsonencode(["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"])
    error_message = "Setting node_labels must not change the Spot pool's taints: it declares the Spot taint, and only that."
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

  # Azure's naming convention marks an Arm-based processor with the additive feature `p` after the
  # vCPU count (checks_nodepools.tf). Ampere Altra v5, Cobalt v6 and the B-series v2 all carry it.
  variables {
    extra_node_pools = [
      { name = "altra", instance_type = "Standard_D4ps_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "altrad", instance_type = "Standard_D2pds_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "altral", instance_type = "Standard_D2pls_v5", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "cobalt", instance_type = "Standard_D4plds_v6", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "bps", instance_type = "Standard_B2ps_v2", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "bpls", instance_type = "Standard_B2pls_v2", min_size = 1, max_size = 2, arch = "arm64" },
      { name = "bpts", instance_type = "Standard_B2pts_v2", min_size = 1, max_size = 2, arch = "arm64" },
    ]
  }

  assert {
    condition     = length(terraform_data.aks_nodepool_guard) == 1 && alltrue([for name in ["altra", "altrad", "altral", "cobalt", "bps", "bpls", "bpts"] : contains(module.aks[0].node_pools[name].node_taints, "alethia.io/arch=arm64:NoSchedule")])
    error_message = "Every Arm64 size (the feature letter p: D/E v5 and v6, B v2) must plan as an arm64 pool carrying the alethia.io/arch taint."
  }
}

run "aks_nodepools_refuses_an_arm64_pool_on_a_b_series_x86_size" {
  command = plan

  variables {
    extra_node_pools = [{ name = "burst", instance_type = "Standard_B2s_v2", min_size = 1, max_size = 2, arch = "arm64" }]
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_refuses_an_amd64_pool_on_a_b_series_arm64_size" {
  command = plan

  variables {
    extra_node_pools = [{ name = "burst", instance_type = "Standard_B2pts_v2", min_size = 1, max_size = 2 }]
  }

  expect_failures = [terraform_data.aks_nodepool_guard]
}

run "aks_nodepools_accepts_the_x86_sizes_as_amd64" {
  command = plan

  # No `p` among the features: x86-64, including a size with no version suffix (M128ms) and one
  # whose features hold other letters (E4ds_v5).
  variables {
    extra_node_pools = [
      { name = "dsv5", instance_type = "Standard_D2s_v5", min_size = 1, max_size = 2 },
      { name = "edsv5", instance_type = "Standard_E4ds_v5", min_size = 1, max_size = 2 },
      { name = "bsv2", instance_type = "Standard_B2s_v2", min_size = 1, max_size = 2 },
      { name = "fsv2", instance_type = "Standard_F4s_v2", min_size = 1, max_size = 2 },
      { name = "mms", instance_type = "Standard_M128ms", min_size = 1, max_size = 2 },
    ]
  }

  assert {
    condition     = length(terraform_data.aks_nodepool_guard) == 1 && alltrue([for name in ["dsv5", "edsv5", "bsv2", "fsv2", "mms"] : module.aks[0].node_pools[name].node_taints == null])
    error_message = "x86 sizes must plan as amd64 pools, with no arm64 taint."
  }
}

run "aks_nodepools_named_spot_pools_use_the_cluster_spot_settings" {
  command = plan

  # aks_spot_enabled stays false: a named Spot pool is enough for the price and the eviction policy
  # to reach something, so CLUSTER-006 must not refuse them.
  variables {
    aks_spot_max_price       = 0.25
    aks_spot_eviction_policy = "Deallocate"
    extra_node_pools         = [{ name = "cheap", instance_type = "Standard_D4s_v5", min_size = 0, max_size = 3, capacity_type = "spot" }]
  }

  assert {
    condition     = module.aks[0].node_pools["cheap"].eviction_policy == "Deallocate" && module.aks[0].node_pools["cheap"].spot_max_price == 0.25
    error_message = "A named Spot pool must use aks_spot_eviction_policy and aks_spot_max_price, not hard-coded values."
  }
}

run "aks_nodepools_spot_settings_with_no_spot_pool_are_still_refused" {
  command = plan

  variables {
    aks_spot_max_price = 0.25
    extra_node_pools   = [{ name = "batch", instance_type = "Standard_D4s_v5", min_size = 0, max_size = 3 }]
  }

  expect_failures = [check.aks_spot_settings_have_a_pool, terraform_data.aks_spot_guard]
}

run "aks_nodepools_named_pools_get_a_distinct_rotation_pool_within_the_name_rule" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "abcdefghij1", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "abcdefghij2", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "g", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
    ]
  }

  assert {
    condition = alltrue([for name in ["abcdefghij1", "abcdefghij2", "g"] :
      can(regex("^[a-z][a-z0-9]{0,11}$", module.aks[0].node_pools[name].rotation_name)) &&
      !contains(["abcdefghij1", "abcdefghij2", "g", "default", "system", "spot"], module.aks[0].node_pools[name].rotation_name) &&
      !can(regex("^pool[0-9]+$", module.aks[0].node_pools[name].rotation_name))
    ]) && module.aks[0].node_pools["abcdefghij1"].rotation_name != module.aks[0].node_pools["abcdefghij2"].rotation_name
    error_message = "Each named pool's temporary_name_for_rotation must be a valid AKS pool name (12 lowercase alphanumerics, starting with a letter), distinct from every pool name and from each other's, so a vm_size change cycles the pool."
  }
}

# #5578: the default pool, pool1..N and spot get a rotation pool too, from the same derivation as the
# named pools, so a vm_size change on them cycles the pool instead of failing the apply.
run "aks_nodepools_positional_pools_get_a_distinct_rotation_pool_within_the_name_rule" {
  command = plan

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5", "Standard_E4s_v5", "Standard_F4s_v2"]
    aks_spot_enabled   = true
    extra_node_pools   = [{ name = "batch", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  assert {
    condition = alltrue([for name in ["default", "pool1", "pool2", "pool3", "spot"] :
      can(regex("^[a-z][a-z0-9]{0,11}$", module.aks[0].node_pools[name].rotation_name)) &&
      !contains(keys(module.aks[0].node_pools), module.aks[0].node_pools[name].rotation_name) &&
      !contains(["system"], module.aks[0].node_pools[name].rotation_name)
    ])
    error_message = "Each positional pool's temporary_name_for_rotation must be a valid AKS pool name (12 lowercase alphanumerics, starting with a letter) and must not be any pool's name."
  }

  assert {
    condition     = length(distinct([for name, p in module.aks[0].node_pools : p.rotation_name])) == length(module.aks[0].node_pools)
    error_message = "No two pools, positional or named, may share a rotation pool name."
  }
}

# #5578: a named pool may not carry another pool's rotation name. Cycling that pool would adopt the
# named pool as its temporary pool and delete it. The names are the literals the module renders
# (pinned in aks_nodepools_nothing_set_renders_the_existing_pools_unchanged), so the validation's
# copy of the derivation and the module's cannot drift apart unnoticed.
run "aks_nodepools_refuses_the_default_pools_rotation_name" {
  command = plan

  variables {
    extra_node_pools = [{ name = "defaulc21f96", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  expect_failures = [var.extra_node_pools]
}

run "aks_nodepools_refuses_the_spot_pools_rotation_name" {
  command = plan

  variables {
    extra_node_pools = [{ name = "spotb2e189", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  expect_failures = [var.extra_node_pools]
}

run "aks_nodepools_refuses_a_positional_pools_rotation_name" {
  command = plan

  variables {
    extra_node_pools = [{ name = "pool15934c3", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  expect_failures = [var.extra_node_pools]
}

run "aks_nodepools_refuses_the_last_positional_pools_rotation_name" {
  command = plan

  # pool100's: the last positional pool AKS's cap of 100 node pools per cluster allows.
  variables {
    extra_node_pools = [{ name = "pool10b2a0c8", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 }]
  }

  expect_failures = [var.extra_node_pools]
}

run "aks_nodepools_refuses_another_named_pools_rotation_name" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "batchd265ae", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "aks_nodepools_accepts_a_name_that_only_resembles_a_rotation_name" {
  command = plan

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5"]
    aks_spot_enabled   = true
    extra_node_pools = [
      { name = "defaulc21f97", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "spotb2e18", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
      { name = "batchd265af", instance_type = "Standard_D4s_v5", min_size = 1, max_size = 2 },
    ]
  }

  assert {
    condition     = alltrue([for name in ["defaulc21f97", "spotb2e18", "batchd265af"] : contains(keys(module.aks[0].node_pools), name)])
    error_message = "A name one character away from a rotation name is an ordinary pool name and must plan."
  }

  assert {
    condition     = module.aks[0].node_pools["default"].rotation_name == "defaulc21f96" && module.aks[0].node_pools["spot"].rotation_name == "spotb2e189" && module.aks[0].node_pools["pool1"].rotation_name == "pool15934c3"
    error_message = "The module must render the rotation names the extra_node_pools validation refuses; if the derivation changes, the validation in variables.tf must change with it."
  }
}

# #5578: the autoscaler owns the node count of an EXISTING autoscaled pool. The first run applies the
# cluster (against the mock); the second changes the sizes the pools start from and plans again.
# Every positional pool and the default pool is autoscaled (auto_scaling_enabled is fixed at true in
# modules/aks), so there is no fixed-count pool here for which the count would still be managed.
run "aks_nodepools_ignore_changes_setup_applies_the_cluster" {
  command = apply

  variables {
    aks_instance_types = ["Standard_D4s_v5", "Standard_D8s_v5"]
    aks_spot_enabled   = true
  }

  assert {
    condition     = module.aks[0].node_pools["default"].node_count == 2 && module.aks[0].node_pools["pool1"].node_count == 2 && module.aks[0].node_pools["spot"].node_count == 0
    error_message = "The pools must be created at their starting sizes: aks_node_desired_size (2) and aks_spot_node_min_size (0)."
  }
}

run "aks_nodepools_an_existing_autoscaled_pools_count_is_left_to_the_autoscaler" {
  command = plan

  # No refresh: the prior state is exactly what the run above applied. OpenTofu 1.9's mock refresh
  # reads an Optional+Computed node_count back as null ("node_count = 2 -> null"), and ignore_changes
  # then keeps that null, which no real refresh produces: the provider's Read sets the live count.
  plan_options {
    refresh = false
  }

  variables {
    aks_instance_types     = ["Standard_D4s_v5", "Standard_D8s_v5"]
    aks_spot_enabled       = true
    aks_node_desired_size  = 4
    aks_spot_node_min_size = 1
  }

  assert {
    condition = (
      module.aks[0].node_pools["default"].node_count == 2 &&
      module.aks[0].node_pools["pool1"].node_count == 2 &&
      module.aks[0].node_pools["spot"].node_count == 0
    )
    error_message = "A changed starting size must not plan a node_count change on an existing default, positional or Spot pool: the autoscaler owns the count once the pool exists."
  }

  assert {
    condition     = module.aks[0].node_pools["spot"].min_count == 1
    error_message = "ignore_changes covers node_count only: the Spot pool's min_count must still follow aks_spot_node_min_size."
  }
}
