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

################################################################################
# 5. Application Gateway + AGIC — and the WAF policy's ONE attachment site
################################################################################

# The default shape is unchanged by this lane: no gateway, no controller, and — because the
# gateway is what a WAF policy binds to — nothing dangling either. This run is what stops the
# gateway becoming a standing per-hour cost on every Azure project that never asked for one.
run "no_application_gateway_by_default" {
  command = plan

  variables {
    provision_aks = true
  }

  assert {
    condition = alltrue([
      length(azurerm_application_gateway.this) == 0,
      length(azurerm_public_ip.application_gateway) == 0,
      length(azurerm_user_assigned_identity.agic) == 0,
      length(azurerm_federated_identity_credential.agic) == 0,
      length(azurerm_role_assignment.agic_gateway) == 0,
      length(azurerm_role_assignment.agic_resource_group_reader) == 0,
    ])
    error_message = "An Application Gateway bills per hour for as long as it exists; it must not appear unless it was asked for."
  }

  assert {
    condition = alltrue([
      output.application_gateway_name == null,
      output.ingress_client_id == null,
      output.waf_policy_id == null,
    ])
    error_message = "With no gateway the ingress/WAF outputs must be null — the runner reads them to decide whether an ingress controller and a WAF attachment shipped."
  }
}

# THE lane. Turning the canvas WAF switch on used to create a policy and associate it with
# nothing; now it also creates the only resource on Azure that a policy CAN be associated with,
# and binds it. Both halves are asserted, because either alone is the bug: a gateway with no
# policy filters nothing, and a policy with no gateway inspects nothing.
run "the_waf_switch_builds_a_gateway_and_binds_the_policy" {
  command = plan

  variables {
    provision_aks     = true
    azure_waf_enabled = true
  }

  assert {
    condition     = length(module.azure_waf) == 1 && length(azurerm_application_gateway.this) == 1
    error_message = "azure_waf_enabled must produce BOTH a WAF policy and the Application Gateway it binds to."
  }

  # A Standard_v2 gateway REJECTS firewall_policy_id outright, and OWASP 3.2 (what
  # modules/azure-waf pins) is a WAF-tier-only rule set — so the SKU is part of the attachment,
  # not a preference. Pinned in both fields: name and tier are separate arguments and a mismatched
  # pair is an apply-time rejection.
  assert {
    condition     = azurerm_application_gateway.this[0].sku[0].name == "WAF_v2" && azurerm_application_gateway.this[0].sku[0].tier == "WAF_v2"
    error_message = "A gateway carrying a firewall policy must be on the WAF_v2 SKU; Standard_v2 refuses the association."
  }

  assert {
    condition     = azurerm_application_gateway.this[0].firewall_policy_id == module.azure_waf[0].policy_id
    error_message = "The gateway's firewall_policy_id must be THE project's WAF policy — this is the attach, and without it the policy is billed and inspects nothing."
  }

  # AGIC is the half that makes Ingress objects mean something. Its identity is federated to the
  # AKS OIDC issuer, so it is cluster-scoped in exactly the way the external-dns/external-secrets
  # identities above are.
  assert {
    condition = alltrue([
      length(azurerm_user_assigned_identity.agic) == 1,
      length(azurerm_federated_identity_credential.agic) == 1,
      length(azurerm_role_assignment.agic_gateway) == 1,
      length(azurerm_role_assignment.agic_resource_group_reader) == 1,
    ])
    error_message = "A gateway on a cluster must come with AGIC's workload identity and its two grants, or nothing translates Ingress objects into gateway configuration."
  }

  # The grants are the documented AGIC minimum. Contributor is scoped to the GATEWAY — widening it
  # to the resource group would hand the ingress controller write access to the cluster, the
  # database and the vault.
  assert {
    condition     = azurerm_role_assignment.agic_gateway[0].scope == azurerm_application_gateway.this[0].id && azurerm_role_assignment.agic_gateway[0].role_definition_name == "Contributor"
    error_message = "AGIC's Contributor grant must be scoped to the Application Gateway alone."
  }

  assert {
    condition     = output.application_gateway_name != null && output.ingress_client_id != null && output.waf_policy_id != null
    error_message = "The runner derives 'an ingress controller shipped' and 'the WAF is attached' from these three outputs; a null here silently downgrades both decisions to skipped."
  }
}

# The gateway is useful without a WAF, and asking for it explicitly must NOT drag a policy in —
# nor leave a WAF_v2 SKU that costs more and filters nothing.
run "an_explicit_gateway_without_the_waf_is_standard_v2" {
  command = plan

  variables {
    provision_aks                     = true
    azure_application_gateway_enabled = true
  }

  assert {
    condition     = length(azurerm_application_gateway.this) == 1 && length(module.azure_waf) == 0
    error_message = "azure_application_gateway_enabled alone must build the gateway and no WAF policy."
  }

  assert {
    condition     = azurerm_application_gateway.this[0].sku[0].name == "Standard_v2" && azurerm_application_gateway.this[0].firewall_policy_id == null
    error_message = "With no WAF policy the gateway must stay on Standard_v2 with no firewall policy — a WAF_v2 SKU with nothing to enforce is pure cost."
  }
}

# The pre-lane defect, still reachable by an operator who explicitly opts OUT of the gateway: the
# policy is built and attaches to nothing. Advisory rather than fatal — projects in exactly this
# state plan today, and the runner records the same fact as a `waf` InfraServiceDecision — but it
# must be SAID, which is what the check block is for.
run "a_waf_switch_with_the_gateway_declined_warns_that_nothing_is_attached" {
  command = plan

  variables {
    provision_aks                     = true
    azure_waf_enabled                 = true
    azure_application_gateway_enabled = false
  }

  assert {
    condition     = length(module.azure_waf) == 1 && length(azurerm_application_gateway.this) == 0
    error_message = "Declining the gateway must still build the policy — the point of the warning is that it exists and is bound to nothing."
  }

  expect_failures = [check.azure_waf_policy_is_attached]
}

# An Application Gateway v2 needs a DEDICATED subnet, and this template only carves one inside the
# VNet it creates (modules/vnet). On a brownfield VNet there is no shape that satisfies both, so an
# EXPLICIT request must fail the plan rather than apply green and leave the operator with no
# ingress and no explanation. A `check` would not have done it — checks never block an apply.
run "an_explicit_gateway_on_a_brownfield_vnet_is_refused" {
  command = plan

  # Left cluster-less on purpose: the guard is decided from variables alone, and attaching a
  # cluster would only drag the brownfield subnet lookup — whose mocked id is not a parseable
  # subnet id — into a run that is not about AKS.
  variables {
    provision_vnet                    = false
    vnet_id                           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/byo/providers/Microsoft.Network/virtualNetworks/byo-vnet"
    subnet_ids                        = ["byo-subnet"]
    azure_application_gateway_enabled = true
  }

  expect_failures = [terraform_data.application_gateway_subnet_guard]
}

# A gateway with no cluster is a legitimate shape (the resource is fine on its own) but a useless
# one: nothing translates Ingress objects, so it serves its placeholder 502 backend and bills for
# the privilege. Inert, not refused — and said out loud.
run "a_gateway_without_a_cluster_installs_no_controller" {
  command = plan

  variables {
    azure_application_gateway_enabled = true
  }

  assert {
    condition     = length(azurerm_application_gateway.this) == 1 && length(azurerm_user_assigned_identity.agic) == 0
    error_message = "With no cluster there is no OIDC issuer to federate AGIC's identity to; the gateway is still built, the controller is not."
  }

  assert {
    condition     = output.application_gateway_name != null && output.ingress_client_id == null
    error_message = "A cluster-less gateway must report itself but export no AGIC client id — an empty identity would render a crash-looping controller."
  }

  expect_failures = [check.application_gateway_has_a_controller]
}

################################################################################
# 6. Node shape — OS-disk placement and the Spot node pool
################################################################################
#
# What these runs can reach: the AKS module's internals are not addressable from a test, so the
# Spot POOL itself cannot be counted here the way azurerm_application_gateway.this is above. What
# IS pinned is everything that decides whether it is built and whether it is legal — the defaults,
# the two gates, and the fact that a cluster with Spot switched on plans at all (which a ForceNew
# misuse or an illegal enum value would break). The pool's rendered arguments are covered only by a
# real apply, and that is stated rather than papered over.

# THE behavior-preserving run. Six new variables reached this template; a project that set none of
# them must plan exactly what it planned before, and `null` on aks_os_disk_type is what makes that
# true by construction rather than by matching Azure's default.
run "the_default_node_shape_adds_nothing" {
  command = plan

  variables {
    provision_aks = true
  }

  assert {
    condition     = var.aks_os_disk_type == null
    error_message = "aks_os_disk_type must default to null so no os_disk_type argument is rendered — an explicit \"Managed\" would be a new argument on every existing cluster, and os_disk_type is ForceNew on the default node pool."
  }

  assert {
    condition     = var.aks_spot_enabled == false
    error_message = "The Spot node pool must be off by default; a cluster that did not ask for interruptible capacity must not grow a pool."
  }

  assert {
    condition     = length(module.aks) == 1
    error_message = "The cluster must still plan with the node-shape knobs at their defaults."
  }
}

# Ephemeral must be an accepted value, not merely a listed one — otherwise the validation could be
# satisfied by refusing every value and the knob would be unreachable.
run "an_ephemeral_os_disk_is_accepted" {
  command = plan

  variables {
    provision_aks    = true
    aks_os_disk_type = "Ephemeral"
  }

  assert {
    condition     = var.aks_os_disk_type == "Ephemeral"
    error_message = "Ephemeral OS-disk placement must be an accepted node shape."
  }
}

# A cluster with Spot switched on has to plan end to end. This is the run that would catch an
# illegal eviction policy, a ForceNew argument on the wrong resource, or a spot pool wired onto the
# default node pool (which AKS refuses outright).
run "a_spot_pool_plans_alongside_the_on_demand_pools" {
  command = plan

  variables {
    provision_aks          = true
    aks_spot_enabled       = true
    aks_spot_max_price     = 0.25
    aks_spot_node_min_size = 0
    aks_spot_node_max_size = 5
  }

  assert {
    condition     = length(module.aks) == 1
    error_message = "A cluster with a Spot node pool must plan."
  }
}

# CLUSTER-005 — a pool whose ceiling sits below its floor is rejected by AKS mid-provision.
run "a_spot_pool_with_max_below_min_blocks_the_plan" {
  command = plan

  variables {
    aks_spot_enabled       = true
    aks_spot_node_min_size = 4
    aks_spot_node_max_size = 2
  }

  expect_failures = [
    check.aks_spot_pool_scales,
    terraform_data.aks_spot_guard,
  ]
}

# CLUSTER-006 — the silent one. A price ceiling with no pool to apply it to is accepted everywhere
# and read by nothing, leaving a customer who believes they bought capped interruptible capacity.
run "a_spot_price_ceiling_without_a_spot_pool_blocks_the_plan" {
  command = plan

  variables {
    aks_spot_max_price = 0.25
  }

  expect_failures = [
    check.aks_spot_settings_have_a_pool,
    terraform_data.aks_spot_guard,
  ]
}

# The same gate from the other side, on a knob nobody would call a mistake in isolation: an
# eviction policy is meaningless without something to evict.
run "a_spot_eviction_policy_without_a_spot_pool_blocks_the_plan" {
  command = plan

  variables {
    aks_spot_eviction_policy = "Deallocate"
  }

  expect_failures = [
    check.aks_spot_settings_have_a_pool,
    terraform_data.aks_spot_guard,
  ]
}
