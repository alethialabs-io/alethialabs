# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The node-pool contract's cases (#5533), run against the REAL Azure template (#5535). Every run
# below is a copy of packages/core/cloud/testdata/nodepool/reference/nodepool_contract.tftest.hcl,
# under the same name, with the same contract values, expect_failures and asserts;
# packages/core/cloud/nodepool_azure_test.go (assertNodePoolContract) fails if one drifts. Read the
# reference file's header for what the cases are and why.
#
# The one substitution the contract allows is made: each pool's instance_type is an Azure VM size of
# the pool's own arch (m7g.large becomes Standard_D4s_v5 on an amd64 pool and Standard_D4ps_v5 on
# an arm64 one, g5.xlarge becomes Standard_NC4as_T4_v3), so a refusal fails for the rule it names
# and not for checks_nodepools.tf's VM-size rules. The two instance_type refusals keep the
# reference's values exactly.
#
# What this file adds, as the reference allows: the mocked providers and the file-level values the
# Azure template needs to plan. The Azure template's OWN asserts on the pools it builds (keys,
# sizes, taints, isolation parity, the unchanged default plan) are in nodepools.tftest.hcl.
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

# Nothing set: the default pool renders with no labels and no taints, and there is no other pool.
run "nodepool_defaults_plan" {
  command = plan

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {}
        taints = []
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# The shape of the docs example (cluster.mdx), widened: a label on every node, a taint for the extra pools, an arm64 batch pool and an amd64 GPU pool. capacity_type stays on-demand because Hetzner refuses spot in a validation of its own.
run "nodepool_accepts_the_portable_example" {
  command = plan

  variables {
    node_labels = {
      team                      = "payments"
      "example.com/cost-centre" = "cc-1042"
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "batch"
        effect = "NoSchedule"
      },
    ]
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4ps_v5"
        min_size      = 4
        max_size      = 4
        arch          = "arm64"
        desired_size  = 4
        labels = {
          workload = "batch"
        }
        taints = [
          {
            key    = "example.com/batch"
            effect = "PreferNoSchedule"
          },
        ]
      },
      {
        name          = "gpu"
        instance_type = "Standard_NC4as_T4_v3"
        min_size      = 0
        max_size      = 2
        taints = [
          {
            key    = "gpu"
            value  = "true"
            effect = "NoSchedule"
          },
          {
            key    = "gpu"
            value  = "true"
            effect = "NoExecute"
          },
        ]
      },
    ]
  }

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
        }
        taints = []
      }
      batch = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
          workload                  = "batch"
          "alethia.io/pool"         = "batch"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "batch"
            effect = "NoSchedule"
          },
          {
            key    = "example.com/batch"
            value  = ""
            effect = "PreferNoSchedule"
          },
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      }
      gpu = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
          "alethia.io/pool"         = "gpu"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "batch"
            effect = "NoSchedule"
          },
          {
            key    = "gpu"
            value  = "true"
            effect = "NoSchedule"
          },
          {
            key    = "gpu"
            value  = "true"
            effect = "NoExecute"
          },
        ]
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# A pool's label wins over node_labels; a pool's taint replaces the node_taint with the same key and effect; node_taints never reach the default pool; alethia.io/pool and the arm64 taint come last.
run "nodepool_renders_the_merge_rules" {
  command = plan

  variables {
    node_labels = {
      team = "a"
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "x"
        effect = "NoSchedule"
      },
      {
        key    = "keep"
        effect = "NoExecute"
      },
    ]
    extra_node_pools = [
      {
        name          = "p"
        instance_type = "Standard_D4ps_v5"
        min_size      = 0
        max_size      = 4
        arch          = "arm64"
        labels = {
          team = "b"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          team = "a"
        }
        taints = []
      }
      p = {
        labels = {
          team              = "b"
          "alethia.io/pool" = "p"
        }
        taints = [
          {
            key    = "keep"
            value  = ""
            effect = "NoExecute"
          },
          {
            key    = "dedicated"
            value  = "y"
            effect = "NoSchedule"
          },
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# The edges are inside the contract: 10 pools, a 12-character name, max_size 100, min_size 0, a 63-character key and value, 24 node_labels and node_taints, 25 labels and taints on a pool, every taint effect.
run "nodepool_accepts_the_limits" {
  command = plan

  variables {
    node_labels = {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"
      l0                                                              = "v"
      l1                                                              = "v"
      l2                                                              = "v"
      l3                                                              = "v"
      l4                                                              = "v"
      l5                                                              = "v"
      l6                                                              = "v"
      l7                                                              = "v"
      l8                                                              = "v"
      l9                                                              = "v"
      l10                                                             = "v"
      l11                                                             = "v"
      l12                                                             = "v"
      l13                                                             = "v"
      l14                                                             = "v"
      l15                                                             = "v"
      l16                                                             = "v"
      l17                                                             = "v"
      l18                                                             = "v"
      l19                                                             = "v"
      l20                                                             = "v"
      l21                                                             = "v"
      l22                                                             = "v"
    }
    node_taints = [
      {
        key    = "t0"
        effect = "NoSchedule"
      },
      {
        key    = "t0"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t0"
        effect = "NoExecute"
      },
      {
        key    = "t1"
        effect = "NoSchedule"
      },
      {
        key    = "t1"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t1"
        effect = "NoExecute"
      },
      {
        key    = "t2"
        effect = "NoSchedule"
      },
      {
        key    = "t2"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t2"
        effect = "NoExecute"
      },
      {
        key    = "t3"
        effect = "NoSchedule"
      },
      {
        key    = "t3"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t3"
        effect = "NoExecute"
      },
      {
        key    = "t4"
        effect = "NoSchedule"
      },
      {
        key    = "t4"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t4"
        effect = "NoExecute"
      },
      {
        key    = "t5"
        effect = "NoSchedule"
      },
      {
        key    = "t5"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t5"
        effect = "NoExecute"
      },
      {
        key    = "t6"
        effect = "NoSchedule"
      },
      {
        key    = "t6"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t6"
        effect = "NoExecute"
      },
      {
        key    = "t7"
        effect = "NoSchedule"
      },
      {
        key    = "t7"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t7"
        effect = "NoExecute"
      },
    ]
    extra_node_pools = [
      {
        name          = "abcdefghijk1"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          l0  = "v"
          l1  = "v"
          l2  = "v"
          l3  = "v"
          l4  = "v"
          l5  = "v"
          l6  = "v"
          l7  = "v"
          l8  = "v"
          l9  = "v"
          l10 = "v"
          l11 = "v"
          l12 = "v"
          l13 = "v"
          l14 = "v"
          l15 = "v"
          l16 = "v"
          l17 = "v"
          l18 = "v"
          l19 = "v"
          l20 = "v"
          l21 = "v"
          l22 = "v"
          l23 = "v"
          l24 = "v"
        }
        taints = [
          {
            key    = "example.com/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
            effect = "NoSchedule"
          },
          {
            key    = "p0"
            effect = "NoSchedule"
          },
          {
            key    = "p1"
            effect = "NoSchedule"
          },
          {
            key    = "p2"
            effect = "NoSchedule"
          },
          {
            key    = "p3"
            effect = "NoSchedule"
          },
          {
            key    = "p4"
            effect = "NoSchedule"
          },
          {
            key    = "p5"
            effect = "NoSchedule"
          },
          {
            key    = "p6"
            effect = "NoSchedule"
          },
          {
            key    = "p7"
            effect = "NoSchedule"
          },
          {
            key    = "p8"
            effect = "NoSchedule"
          },
          {
            key    = "p9"
            effect = "NoSchedule"
          },
          {
            key    = "p10"
            effect = "NoSchedule"
          },
          {
            key    = "p11"
            effect = "NoSchedule"
          },
          {
            key    = "p12"
            effect = "NoSchedule"
          },
          {
            key    = "p13"
            effect = "NoSchedule"
          },
          {
            key    = "p14"
            effect = "NoSchedule"
          },
          {
            key    = "p15"
            effect = "NoSchedule"
          },
          {
            key    = "p16"
            effect = "NoSchedule"
          },
          {
            key    = "p17"
            effect = "NoSchedule"
          },
          {
            key    = "p18"
            effect = "NoSchedule"
          },
          {
            key    = "p19"
            effect = "NoSchedule"
          },
          {
            key    = "p20"
            effect = "NoSchedule"
          },
          {
            key    = "p21"
            effect = "NoSchedule"
          },
          {
            key    = "p22"
            effect = "NoSchedule"
          },
          {
            key    = "p23"
            effect = "NoSchedule"
          },
        ]
      },
      {
        name          = "p0"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p1"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p2"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p3"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p4"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p5"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p6"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p7"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p8"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
    ]
  }

  assert {
    condition     = length(output.nodepool_contract_render) == 11
    error_message = "nodepool_contract_render must hold the default pool and every extra pool."
  }
}

# A prefix that merely CONTAINS a reserved domain is the user's own: kubernetes.io.example.com does not end in kubernetes.io.
run "nodepool_accepts_a_lookalike_outside_the_reserved_domains" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.io.example.com/team" = "a"
    }
    node_taints = [
      {
        key    = "alethia.io.example.com/x"
        effect = "NoSchedule"
      },
    ]
  }

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          "kubernetes.io.example.com/team" = "a"
        }
        taints = []
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

run "nodepool_refuses_a_label_key_starting_with_a_dash" {
  command = plan

  variables {
    node_labels = {
      "-team" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_name_over_63" {
  command = plan

  variables {
    node_labels = {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "a"
    }
  }

  expect_failures = [var.node_labels]
}

# EKS caps the WHOLE key at 63: a valid Kubernetes key of 64 is refused.
run "nodepool_refuses_a_label_key_over_63_with_its_prefix" {
  command = plan

  variables {
    node_labels = {
      "example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

# EKS refuses an empty label value.
run "nodepool_refuses_an_empty_label_value" {
  command = plan

  variables {
    node_labels = {
      team = ""
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_value_with_a_space" {
  command = plan

  variables {
    node_labels = {
      team = "pay ments"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_value_over_63" {
  command = plan

  variables {
    node_labels = {
      team = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_25th_node_label" {
  command = plan

  variables {
    node_labels = {
      l0  = "v"
      l1  = "v"
      l2  = "v"
      l3  = "v"
      l4  = "v"
      l5  = "v"
      l6  = "v"
      l7  = "v"
      l8  = "v"
      l9  = "v"
      l10 = "v"
      l11 = "v"
      l12 = "v"
      l13 = "v"
      l14 = "v"
      l15 = "v"
      l16 = "v"
      l17 = "v"
      l18 = "v"
      l19 = "v"
      l20 = "v"
      l21 = "v"
      l22 = "v"
      l23 = "v"
      l24 = "v"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_kubernetes_io" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.io/role" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_node_role" {
  command = plan

  variables {
    node_labels = {
      "node-role.kubernetes.io/worker" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_node_restriction" {
  command = plan

  variables {
    node_labels = {
      "node-restriction.kubernetes.io/team" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_no_dot_boundary" {
  command = plan

  variables {
    node_labels = {
      "examplekubernetes.io/x" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_k8s_io" {
  command = plan

  variables {
    node_labels = {
      "k8s.io/x" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_karpenter_sh" {
  command = plan

  variables {
    node_labels = {
      "karpenter.sh/nodepool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_karpenter_k8s_aws" {
  command = plan

  variables {
    node_labels = {
      "karpenter.k8s.aws/instance-family" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_amazonaws_com" {
  command = plan

  variables {
    node_labels = {
      "eks.amazonaws.com/nodegroup" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_cloud_google_com" {
  command = plan

  variables {
    node_labels = {
      "cloud.google.com/gke-nodepool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_gke_io" {
  command = plan

  variables {
    node_labels = {
      "iam.gke.io/gke-metadata-server-enabled" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_azure_com" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.azure.com/agentpool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_hetzner_cloud" {
  command = plan

  variables {
    node_labels = {
      "csi.hetzner.cloud/location" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_alethia_io" {
  command = plan

  variables {
    node_labels = {
      "alethia.io/pool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_taint_effect" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        effect = "NoScheduled"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_duplicate_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = "a"
        effect = "NoSchedule"
      },
      {
        key    = "gpu"
        value  = "b"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_25th_node_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "t0"
        effect = "NoSchedule"
      },
      {
        key    = "t1"
        effect = "NoSchedule"
      },
      {
        key    = "t2"
        effect = "NoSchedule"
      },
      {
        key    = "t3"
        effect = "NoSchedule"
      },
      {
        key    = "t4"
        effect = "NoSchedule"
      },
      {
        key    = "t5"
        effect = "NoSchedule"
      },
      {
        key    = "t6"
        effect = "NoSchedule"
      },
      {
        key    = "t7"
        effect = "NoSchedule"
      },
      {
        key    = "t8"
        effect = "NoSchedule"
      },
      {
        key    = "t9"
        effect = "NoSchedule"
      },
      {
        key    = "t10"
        effect = "NoSchedule"
      },
      {
        key    = "t11"
        effect = "NoSchedule"
      },
      {
        key    = "t12"
        effect = "NoSchedule"
      },
      {
        key    = "t13"
        effect = "NoSchedule"
      },
      {
        key    = "t14"
        effect = "NoSchedule"
      },
      {
        key    = "t15"
        effect = "NoSchedule"
      },
      {
        key    = "t16"
        effect = "NoSchedule"
      },
      {
        key    = "t17"
        effect = "NoSchedule"
      },
      {
        key    = "t18"
        effect = "NoSchedule"
      },
      {
        key    = "t19"
        effect = "NoSchedule"
      },
      {
        key    = "t20"
        effect = "NoSchedule"
      },
      {
        key    = "t21"
        effect = "NoSchedule"
      },
      {
        key    = "t22"
        effect = "NoSchedule"
      },
      {
        key    = "t23"
        effect = "NoSchedule"
      },
      {
        key    = "t24"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_key_with_a_space" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "g pu"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_key_over_63_with_its_prefix" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

# Leave value out instead; an empty value is refused so that "" can only mean none.
run "nodepool_refuses_an_empty_taint_value" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = ""
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_value_over_63" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

# alethia.io/arch is the platform's arm64 taint (#5534); a user may not set or spoof it.
run "nodepool_refuses_the_platform_arch_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "alethia.io/arch"
        value  = "arm64"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_in_kubernetes_io" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "node.kubernetes.io/unschedulable"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_in_azure_com" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "kubernetes.azure.com/scalesetpriority"
        value  = "spot"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_pool_name_uppercase" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "Batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_over_12" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "abcdefghijklm"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_leading_digit" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "1batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_hyphen" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "bat-ch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_default" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "default"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_system" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "system"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_spot" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "spot"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_pool1" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "pool1"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_pool12" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "pool12"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_duplicate_pool_name" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_eleventh_pool" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "p0"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p1"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p2"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p3"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p4"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p5"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p6"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p7"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p8"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p9"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p10"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_empty_instance_type" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = ""
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_instance_type_with_a_space" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "m7g large"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_unknown_arch" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        arch          = "x86_64"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_unknown_capacity_type" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        capacity_type = "preemptible"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_min_over_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 5
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_desired_under_min" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 2
        max_size      = 4
        desired_size  = 1
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_desired_over_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        desired_size  = 5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_max_zero" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 0
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_max_over_100" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 101
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_negative_min" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = -1
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_fractional_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 1.5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_fractional_desired" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        desired_size  = 1.5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_key" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          "-x" = "a"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          x = "a b"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_empty_pool_label_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          x = ""
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_26th_pool_label" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          l0  = "v"
          l1  = "v"
          l2  = "v"
          l3  = "v"
          l4  = "v"
          l5  = "v"
          l6  = "v"
          l7  = "v"
          l8  = "v"
          l9  = "v"
          l10 = "v"
          l11 = "v"
          l12 = "v"
          l13 = "v"
          l14 = "v"
          l15 = "v"
          l16 = "v"
          l17 = "v"
          l18 = "v"
          l19 = "v"
          l20 = "v"
          l21 = "v"
          l22 = "v"
          l23 = "v"
          l24 = "v"
          l25 = "v"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

# alethia.io/pool is the platform's portable pool selector; a pool may not override it.
run "nodepool_refuses_the_platform_pool_label" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          "alethia.io/pool" = "other"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_in_kubernetes_io" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        labels = {
          "node-role.kubernetes.io/batch" = "x"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_effect" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            effect = "Never"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_duplicate_pool_taint" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            effect = "NoSchedule"
          },
          {
            key    = "x"
            value  = "y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_26th_pool_taint" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "t0"
            effect = "NoSchedule"
          },
          {
            key    = "t1"
            effect = "NoSchedule"
          },
          {
            key    = "t2"
            effect = "NoSchedule"
          },
          {
            key    = "t3"
            effect = "NoSchedule"
          },
          {
            key    = "t4"
            effect = "NoSchedule"
          },
          {
            key    = "t5"
            effect = "NoSchedule"
          },
          {
            key    = "t6"
            effect = "NoSchedule"
          },
          {
            key    = "t7"
            effect = "NoSchedule"
          },
          {
            key    = "t8"
            effect = "NoSchedule"
          },
          {
            key    = "t9"
            effect = "NoSchedule"
          },
          {
            key    = "t10"
            effect = "NoSchedule"
          },
          {
            key    = "t11"
            effect = "NoSchedule"
          },
          {
            key    = "t12"
            effect = "NoSchedule"
          },
          {
            key    = "t13"
            effect = "NoSchedule"
          },
          {
            key    = "t14"
            effect = "NoSchedule"
          },
          {
            key    = "t15"
            effect = "NoSchedule"
          },
          {
            key    = "t16"
            effect = "NoSchedule"
          },
          {
            key    = "t17"
            effect = "NoSchedule"
          },
          {
            key    = "t18"
            effect = "NoSchedule"
          },
          {
            key    = "t19"
            effect = "NoSchedule"
          },
          {
            key    = "t20"
            effect = "NoSchedule"
          },
          {
            key    = "t21"
            effect = "NoSchedule"
          },
          {
            key    = "t22"
            effect = "NoSchedule"
          },
          {
            key    = "t23"
            effect = "NoSchedule"
          },
          {
            key    = "t24"
            effect = "NoSchedule"
          },
          {
            key    = "t25"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_key" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            value  = "a b"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_the_platform_arch_taint_on_a_pool" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4ps_v5"
        min_size      = 0
        max_size      = 4
        arch          = "arm64"
        taints = [
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_in_gke_io" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "Standard_D4s_v5"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "node.gke.io/x"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

