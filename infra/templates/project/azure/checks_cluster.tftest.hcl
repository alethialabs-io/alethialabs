# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that `provision_aks = false` plans, and that checks_cluster.tf's BYOC access guards refuse.
#
# The AWS twin of the first property was broken for the whole life of the template: thirteen call
# sites indexed `module.eks[0]` outside any count, so `provision_eks = false` died at plan with
# "Invalid index … module.eks is empty tuple" before a single resource existed (#1772). Azure gets
# this right today — every module.aks[0] reference sits behind a `count` or a ternary that carries
# `var.provision_aks` — but nothing PINNED it, and the AWS defect was equally invisible to
# `tofu validate`, which never expands a count and never renders an output. This file is the pin.
#
# It is also the first .tftest.hcl in this directory, which is what switches `tofu test` on for
# azure at all: .github/workflows/infra-templates.yml skips the step with a notice for any cloud
# that has no suite, so until now azure's guards were never executed by CI.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

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

  # checks_secrets.tf asserts the vault URI starts with https://, which the generated string does not.
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
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
}

mock_provider "azuread" {}
mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000001"
  location        = "westeurope"
  environment     = "production"
  project_name    = "alethia-nl"

  # THE shape under test. Runs that need a cluster turn it back on explicitly.
  provision_aks = false
}

################################################################################
# 1. The cluster-less shape plans and creates nothing cluster-scoped
################################################################################

run "a_clusterless_project_plans" {
  command = plan

  assert {
    condition     = length(module.aks) == 0
    error_message = "provision_aks = false must produce no AKS module instance."
  }

  # Every workload identity here is federated to the AKS OIDC issuer (module.aks[0].oidc_issuer_url).
  # These are the Azure analogues of the AWS IRSA roles that made `provision_eks = false` unplannable.
  assert {
    condition = alltrue([
      length(azurerm_user_assigned_identity.external_dns) == 0,
      length(azurerm_federated_identity_credential.external_dns) == 0,
      length(azurerm_user_assigned_identity.external_secrets) == 0,
      length(azurerm_federated_identity_credential.external_secrets) == 0,
      length(azurerm_role_assignment.external_dns_dns) == 0,
      length(azurerm_role_assignment.external_secrets_kv) == 0,
    ])
    error_message = "No cluster means no OIDC issuer to federate to — every workload identity must drop out."
  }

  assert {
    condition = alltrue([
      output.aks_cluster_name == null,
      output.aks_cluster_endpoint == null,
      output.aks_cluster_ca_certificate == null,
      output.external_dns_client_id == null,
      output.external_secrets_client_id == null,
    ])
    error_message = "Cluster outputs must be null on a cluster-less shape, not an Invalid index error."
  }
}

# The cross-account ACR pull identity is gated on `registry_pull_provider`, a flag orthogonal to the
# cluster — and registry-pull.tf's local already carries `var.provision_aks` for exactly that reason.
# On AWS the corresponding local did NOT, which is one of the wrong-flag doors into #1772. Pinned so
# azure's version cannot lose the term.
run "a_clusterless_project_ignores_the_cross_account_registry_identity" {
  command = plan

  variables {
    registry_pull_provider        = "acr-xacct"
    registry_pull_target_role_arn = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/registry/providers/Microsoft.ContainerRegistry/registries/shared"
  }

  assert {
    condition     = local.enable_acr_pull == false
    error_message = "acr-xacct without a cluster has no KSA to annotate; the identity must be inert, not a failed plan."
  }
}

################################################################################
# 2. Keyless Entra DB identities — a database WITHOUT a cluster
################################################################################

# `create_azure_db + azure_db_iam_auth` is the Azure analogue of the AWS shape that DID break
# (rds.tf passed the cluster's node security group to a cluster-less database, #1772). Here the SERVER
# side must still be built — the dedicated db_admin identity is the server's Entra administrator and
# is useful without a cluster — while the APP side, which needs the OIDC issuer to federate, must not
# be. app-db-identity.tf gets that split right; this pins it, because the two disjuncts of
# `enable_app_db_identity` are easy to get wrong in exactly the way #1772 was.
run "a_keyless_mysql_without_a_cluster_plans" {
  command = plan

  variables {
    create_azure_db         = true
    azure_db_iam_auth       = true
    azure_db_engine         = "mysql"
    azure_db_engine_version = "8.0.21"
  }

  assert {
    condition = alltrue([
      length(azurerm_user_assigned_identity.app_db) == 0,
      length(azurerm_federated_identity_credential.app_db) == 0,
      length(azurerm_federated_identity_credential.db_admin) == 0,
    ])
    error_message = "The app-side keyless identity federates to the AKS OIDC issuer; with no cluster it must not be created."
  }

  # The server admin is NOT cluster-scoped. Without this half the run would also pass if the whole
  # keyless MySQL lane were disabled by a cluster-less shape, silently regressing #1464.
  assert {
    condition     = length(azurerm_user_assigned_identity.db_admin) == 1 && length(azurerm_mysql_flexible_server_active_directory_administrator.db_admin) == 1
    error_message = "The MySQL Entra administrator is a SERVER-side identity and must survive a cluster-less shape."
  }
}

# PostgreSQL is deliberately NOT symmetric with MySQL, and the difference is a decision worth
# pinning. Its whole keyless lane — including the Entra admin registration — is gated on
# `enable_app_db_aad`, which carries `var.provision_aks`, so a cluster-less shape would leave
# `azure_db_iam_auth = true` with no identity able to log in at all. checks_data.tf refuses that
# outright rather than provisioning a database nothing can reach. Asserting the resources are absent
# would have described the same state while hiding the fact that it is REJECTED, not merely inert.
run "keyless_postgres_without_a_cluster_is_refused" {
  command = plan

  variables {
    create_azure_db         = true
    azure_db_iam_auth       = true
    azure_db_engine         = "postgres"
    azure_db_engine_version = "16"
  }

  expect_failures = [check.keyless_azure_db_app_identity_wired]
}

################################################################################
# 3. The other side — with a cluster the identities must actually exist
################################################################################

# Everything above would also pass if `module "aks"` and every workload identity were simply
# deleted. This run is what makes the suite an invariant rather than a licence to remove them.
run "a_cluster_creates_every_workload_identity" {
  command = plan

  variables {
    provision_aks           = true
    create_azure_db         = true
    azure_db_iam_auth       = true
    azure_db_engine         = "mysql"
    azure_db_engine_version = "8.0.21"
  }

  assert {
    condition = alltrue([
      length(module.aks) == 1,
      length(azurerm_user_assigned_identity.external_dns) == 1,
      length(azurerm_federated_identity_credential.external_dns) == 1,
      length(azurerm_user_assigned_identity.external_secrets) == 1,
      length(azurerm_federated_identity_credential.external_secrets) == 1,
    ])
    error_message = "With provision_aks = true the cluster and its workload identities must all be created."
  }

  assert {
    condition = alltrue([
      length(azurerm_user_assigned_identity.app_db) == 1,
      length(azurerm_federated_identity_credential.app_db) == 1,
      length(azurerm_user_assigned_identity.db_admin) == 1,
      length(azurerm_federated_identity_credential.db_admin) == 1,
    ])
    error_message = "Keyless MySQL on AKS must create BOTH the app UAMI and the dedicated db_admin UAMI, each with its federation."
  }
}

################################################################################
# 4. checks_cluster.tf — the BYOC access guards, from both sides
################################################################################

# AKS rejects a non-GUID admin group id, so a group NAME must be caught at plan rather than mid
# provision. These are pure-variable checks, so they are decided without a cluster.
run "an_admin_group_name_instead_of_an_object_id_is_refused" {
  command = plan

  variables {
    aks_admin_group_object_ids = ["platform-admins"]
  }

  expect_failures = [check.aks_admin_group_object_ids_are_guids]
}

# The acceptance half. Without it the guard could be satisfied by rejecting every value, and a regex
# that refused legal object ids would block a real tenant before anyone noticed.
run "a_guid_admin_group_object_id_is_accepted" {
  command = plan

  variables {
    aks_admin_group_object_ids = ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"]
    aks_authorized_ip_ranges   = ["203.0.113.0/24"]
  }
}

run "a_malformed_authorized_ip_range_is_refused" {
  command = plan

  variables {
    aks_authorized_ip_ranges = ["203.0.113.0/33"]
  }

  expect_failures = [check.aks_authorized_ip_ranges_valid_cidrs]
}

# An AKS cluster the apply-runner cannot administer is useless: with Azure RBAC for Kubernetes on,
# the runner's token 401s and ArgoCD is never installed. Turning the creator-admin grant off without
# supplying an admin group leaves exactly that cluster, so it must fail the PLAN — a future default
# flip must red this file rather than silently brick provisioning.
run "no_runner_reachable_admin_path_is_refused" {
  command = plan

  variables {
    aks_enable_creator_admin   = false
    aks_admin_group_object_ids = []
  }

  expect_failures = [check.aks_runner_admin_path]
}

# The other admin path: creator-admin off is fine PROVIDED an Entra admin group is supplied.
run "an_admin_group_is_a_valid_runner_admin_path" {
  command = plan

  variables {
    aks_enable_creator_admin   = false
    aks_admin_group_object_ids = ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"]
  }
}
