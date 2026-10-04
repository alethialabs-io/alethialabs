module "aks" {
  source = "./modules/aks"
  count  = var.provision_aks ? 1 : 0

  # The role assignment is a HARD dependency, not an ordering preference: AKS encrypts as its own
  # identity, and a cluster created against a key that identity cannot yet use fails outright
  # (#2004).
  depends_on = [module.vnet, azurerm_role_assignment.aks_secrets_kms]

  location        = var.location
  environment     = var.environment
  project_name    = var.project_name
  cluster_name    = local.aks_name
  cluster_version = var.aks_cluster_version

  cluster_identity_id = local.azure_secrets_encryption ? one(azurerm_user_assigned_identity.aks[*].id) : ""
  secrets_kms_key_id  = local.azure_secrets_encryption ? one(azurerm_key_vault_key.aks_secrets[*].id) : ""

  # Derived in checks_naming.tf (NAMING-002), not left to Azure: the auto-derived
  # "MC_<resource_group>_<cluster_name>_<location>" rendered 82 characters against an 80-character
  # cap on the e2e nightly and failed the apply mid-create (#1921).
  node_resource_group = local.azure_aks_node_resource_group
  resource_group_name = azurerm_resource_group.main.name
  vnet_subnet_id      = try(module.vnet[0].private_subnet_id, null) != null ? module.vnet[0].private_subnet_id : one(data.azurerm_subnet.existing[*].id)

  machine_types     = var.aks_instance_types
  node_min_size     = var.aks_node_min_size
  node_max_size     = var.aks_node_max_size
  node_desired_size = var.aks_node_desired_size
  disk_size_gb      = var.aks_disk_size_gb

  # OS-disk PLACEMENT (Managed vs Ephemeral). Null by default = the argument is not rendered, so
  # every existing cluster plans unchanged. AKS carries no OS-disk SKU or IOPS to expose.
  os_disk_type = var.aks_os_disk_type

  # Spot node pool (aws parity: eks_ng_capacity_type). Off by default; when on it is an ADDITIONAL
  # pool beside the on-demand ones, because AKS refuses a Spot default pool and the three spot
  # arguments are ForceNew.
  spot_enabled         = var.aks_spot_enabled
  spot_max_price       = var.aks_spot_max_price
  spot_eviction_policy = var.aks_spot_eviction_policy
  spot_node_min_size   = var.aks_spot_node_min_size
  spot_node_max_size   = var.aks_spot_node_max_size

  # BYOC B4.1 access-control knobs (both default-empty = behavior-preserving)
  admin_group_object_ids = var.aks_admin_group_object_ids
  authorized_ip_ranges   = var.aks_authorized_ip_ranges

  # BYOC AZ-SELF-ADMIN — grant the apply/runner identity RBAC Cluster Admin (default true).
  enable_creator_admin = var.aks_enable_creator_admin

  # Container Insights → the workspace below, only when aks_log_retention_days created one. Empty
  # renders no oms_agent block, which is what every cluster carried before the knob existed.
  log_analytics_workspace_id = one(azurerm_log_analytics_workspace.aks[*].id) != null ? one(azurerm_log_analytics_workspace.aks[*].id) : ""

  tags = local.azure_default_tags
}

################################################################################
# Control-plane and container log retention (aks_log_retention_days)
################################################################################
# CUSTOMIZABILITY-PARITY top gap #1 — the AWS template has had eks_cloudwatch_log_group_retention_in_days
# since it was written. Null (the default) creates NONE of the four resources below, so a cluster
# that never set the knob plans exactly as before and starts paying for nothing: a Log Analytics
# workspace bills per GB ingested, and a diagnostic setting is what makes it ingest.
#
# Set, it builds the one shape Azure documents for Container Insights under managed-identity auth:
#   · a workspace whose retention IS the knob (control-plane and container logs share it),
#   · the cluster's oms_agent pointed at it (module above),
#   · a data collection rule + association — MSI-mode Container Insights reads its configuration
#     from the DCR, and without one the add-on installs and collects nothing,
#   · a diagnostic setting shipping kube-apiserver and kube-audit-admin. kube-audit-admin, not
#     kube-audit: it drops the get/list audit events that are most of kube-audit's volume and none
#     of a reviewer's questions, which is the cost line this knob otherwise moves the most.
#
# Gated on provision_aks too: a workspace for a cluster that does not exist would be billed for
# logs nothing sends.

locals {
  aks_log_retention = var.provision_aks && var.aks_log_retention_days != null

  # 4-63 characters, alphanumerics and hyphens, ending alphanumeric (Log Analytics' rule; a DCR's
  # 64-character cap is looser). The readable form mirrors aks_name; truncation only bites a name
  # AKS itself would have refused, and only one workspace exists per resource group.
  aks_log_workspace_name = replace(substr(replace("log-${local.location_short}-${var.environment}-${var.project_name}", "/[^a-zA-Z0-9-]/", "-"), 0, 63), "/-+$/", "")
}

resource "azurerm_log_analytics_workspace" "aks" {
  count = local.aks_log_retention ? 1 : 0

  name                = local.aks_log_workspace_name
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.aks_log_retention_days

  tags = local.azure_default_tags
}

resource "azurerm_monitor_data_collection_rule" "aks_container_insights" {
  count = local.aks_log_retention ? 1 : 0

  name                = "dcr-${local.aks_log_workspace_name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name

  destinations {
    log_analytics {
      name                  = "ciworkspace"
      workspace_resource_id = one(azurerm_log_analytics_workspace.aks[*].id)
    }
  }

  data_flow {
    streams      = ["Microsoft-ContainerInsights-Group-Default"]
    destinations = ["ciworkspace"]
  }

  data_sources {
    extension {
      name           = "ContainerInsightsExtension"
      extension_name = "ContainerInsights"
      streams        = ["Microsoft-ContainerInsights-Group-Default"]
      extension_json = jsonencode({
        dataCollectionSettings = {
          interval               = "1m"
          namespaceFilteringMode = "Off"
          enableContainerLogV2   = true
        }
      })
    }
  }

  tags = local.azure_default_tags
}

resource "azurerm_monitor_data_collection_rule_association" "aks_container_insights" {
  count = local.aks_log_retention ? 1 : 0

  name                    = "ContainerInsightsExtension"
  target_resource_id      = module.aks[0].cluster_id
  data_collection_rule_id = one(azurerm_monitor_data_collection_rule.aks_container_insights[*].id)
}

resource "azurerm_monitor_diagnostic_setting" "aks_control_plane" {
  count = local.aks_log_retention ? 1 : 0

  name                       = "aks-control-plane-logs"
  target_resource_id         = module.aks[0].cluster_id
  log_analytics_workspace_id = one(azurerm_log_analytics_workspace.aks[*].id)

  enabled_log {
    category = "kube-apiserver"
  }

  enabled_log {
    category = "kube-audit-admin"
  }
}
