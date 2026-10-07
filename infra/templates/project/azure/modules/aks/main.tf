################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = merge(var.tags, {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "opentofu"
  })

  # The node_labels ARGUMENT the default pool and the positional pools render (#5535). Null when
  # none were set, which is the argument those blocks have always left out, so a cluster that sets
  # nothing plans unchanged. One expression for both, output below so the root's tofu test can tell
  # null from {} (a mocked plan reads both back as {}).
  node_labels_argument = length(var.node_labels) > 0 ? var.node_labels : null

  # temporary_name_for_rotation for the pools this module names itself (#5578): the default pool,
  # pool1..N and spot. The same derivation as the named pools below, inside AKS's 12-character
  # pool-name rule: up to six characters of the pool's name (which starts with a letter) plus six
  # hex characters of its hash, so no two pools share one and none is itself a pool's name.
  # Rendered: default -> defaulc21f96, spot -> spotb2e189, pool1 -> pool15934c3.
  rotation_names = {
    for name in concat(["default", "spot"], [for i in range(1, max(length(var.machine_types), 1)) : "pool${i}"]) :
    name => "${substr(name, 0, min(6, length(name)))}${substr(md5(name), 0, 6)}"
  }
}

################################################################################
# AKS Cluster
################################################################################

# API-server IP allow-list (AVD-AZU-0041) is suppressed in infra/.trivyignore: it's
# customer-specific (the external runner + operator kubectl need access), so default-locking
# would break provisioning. Left customer-configurable per environment. (RBAC is enabled above.)
resource "azurerm_kubernetes_cluster" "this" {
  name                = var.cluster_name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = var.cluster_name
  kubernetes_version  = var.cluster_version

  # SET EXPLICITLY, and it must stay that way (#1921). Unset, Azure derives this itself as
  # "MC_<resource_group>_<cluster_name>_<location>" and refuses the CREATE with
  # "400 InvalidParameter: The length of the node resource group name is too long. The maximum
  # length is 80 and the length of the value provided is 82" — 489 seconds into apply, because a
  # name that only exists server-side cannot be checked at plan. The value is derived against an
  # 80-character budget in the root's checks_naming.tf (NAMING-002) and reproduces Azure's own form
  # byte for byte whenever it fits, so this is a no-op for every cluster that already exists. It is
  # ForceNew: a value that differs from what a live cluster carries REPLACES the cluster.
  node_resource_group = var.node_resource_group

  # --- Identity -----------------------------------------------------------
  # UserAssigned only when #2004's KMS encryption is on, because that is the only shape in which the
  # Key Vault grant can exist BEFORE the cluster does (see secrets-encryption.tf). Otherwise the
  # cluster keeps the system-assigned identity it has always had, so a project that turns encryption
  # off renders exactly as it did.
  identity {
    type         = var.cluster_identity_id != "" ? "UserAssigned" : "SystemAssigned"
    identity_ids = var.cluster_identity_id != "" ? [var.cluster_identity_id] : null
  }

  # Envelope-encrypt Kubernetes Secrets in etcd (#2004). Rendered only when a key was passed:
  # emitting the block with an empty id is not "off", it is an invalid binding.
  dynamic "key_management_service" {
    for_each = var.secrets_kms_key_id != "" ? [1] : []
    content {
      key_vault_key_id = var.secrets_kms_key_id
      # Public: the runner reaches the vault over the internet, and a private-endpoint vault would
      # need the cluster's VNet integrated with it — a topology this template does not build.
      key_vault_network_access = "Public"
    }
  }

  # Container Insights (aks_log_retention_days at the root). Gated on the BOOLEAN, not on the
  # workspace id — the id is unknown until the workspace exists, so on a first apply a gate on it
  # would leave the block count unknown. An oms_agent block with an empty id is not "off", it is an invalid
  # binding — and with no block the cluster renders exactly as it did before the knob existed.
  # Managed-identity auth, not the retired shared-key agent auth; the root pairs it with the data
  # collection rule that MSI-mode Container Insights reads its configuration from.
  dynamic "oms_agent" {
    for_each = var.log_analytics_enabled ? [1] : []
    content {
      log_analytics_workspace_id      = var.log_analytics_workspace_id
      msi_auth_for_monitoring_enabled = true
    }
  }

  workload_identity_enabled = true
  oidc_issuer_enabled       = true

  # Kubernetes RBAC (AVD-AZU-0042) — safe to enable unconditionally.
  role_based_access_control_enabled = true

  # AAD-integrated cluster with Azure RBAC for Kubernetes (BYOC AZ-SELF-ADMIN — the Azure
  # analogue of EKS #470). Rendered UNCONDITIONALLY: the provisioning runner authenticates
  # to AKS with its own AAD workload-identity token (apps/runner/internal/agent/kube_token.go),
  # which is only authorized when Azure RBAC is on AND the apply identity holds an RBAC role
  # (granted by azurerm_role_assignment.runner_cluster_admin below). `admin_group_object_ids`
  # (BYOC B4.1) still grants the customer's Entra groups cluster-admin; empty = none. azurerm
  # 4.x: AAD RBAC is always managed, so the block carries only these two args.
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    admin_group_object_ids = var.admin_group_object_ids
  }

  # API-server IP allow-list (BYOC B4.1, AVD-AZU-0041). Rendered only when authorized
  # ranges are supplied — an empty list leaves the block off so the API server stays
  # open to all source IPs (the pre-existing customer-configurable default).
  dynamic "api_server_access_profile" {
    for_each = length(var.authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.authorized_ip_ranges
    }
  }

  # --- Default node pool --------------------------------------------------
  default_node_pool {
    name           = "default"
    vm_size        = var.machine_types[0]
    vnet_subnet_id = var.vnet_subnet_id

    os_disk_size_gb = var.disk_size_gb
    # OS-disk PLACEMENT (Managed vs Ephemeral), not a disk SKU — AKS exposes no OS-disk SKU or IOPS
    # at all; it derives both from vm_size. Null renders no argument, which is exactly the config
    # this block carried before the knob existed. NOT ForceNew in azurerm 4.x: like vm_size and
    # os_disk_size_gb, changing it CYCLES the pool through temporary_name_for_rotation below, which
    # replaces every node in the pool but not the pool or the cluster.
    os_disk_type = var.os_disk_type

    # A change to vm_size, os_disk_type, os_disk_size_gb, max_pods or vnet_subnet_id cycles the pool
    # through this temporary system pool instead of failing the apply (#5578). Adding the argument
    # is not one of those changes: it is stored in state and sent with one update of the pool, which
    # carries the pool's current settings and moves no node.
    temporary_name_for_rotation = local.rotation_names["default"]

    node_count           = var.node_desired_size
    min_count            = var.node_min_size
    max_count            = var.node_max_size
    auto_scaling_enabled = true
    max_pods             = 110

    # node_labels (#5535): null when none were set, which is the argument this block has always
    # left out, so a cluster that sets nothing plans unchanged. Updated in place, not rotated.
    node_labels = local.node_labels_argument

    upgrade_settings {
      max_surge = "10%"
    }
  }

  # --- Network profile ----------------------------------------------------
  # Namespace-placement tenant isolation (#1012 — cloud parity with the AWS Fabric fix).
  # `network_policy = "calico"` turns on NetworkPolicy ENFORCEMENT, so the guardrail bundle's
  # default-deny NetworkPolicy (incl. the metadata-egress-deny to 169.254.169.254 that blocks a
  # tenant Pod from assuming the node/kubelet managed identity via IMDS) actually enforces —
  # unlike the unconfigured VPC-CNI on AWS where the same NP was a no-op. Combined with Workload
  # Identity (workload_identity_enabled/oidc_issuer_enabled above), tenant Pods get a scoped AAD
  # identity instead of the node identity. (The metadata-deny NP itself is applied at deploy time
  # by the guardrail bundle, not this tofu template.)
  network_profile {
    network_plugin    = "azure"
    network_policy    = "calico"
    load_balancer_sku = "standard"
    service_cidr      = "172.16.0.0/16"
    dns_service_ip    = "172.16.0.10"
  }

  tags = local.common_tags

  # The autoscaler owns the default pool's node count once the cluster exists (#5578).
  # node_count (aks_node_desired_size) is where the pool STARTS. Without this, every plan after the
  # autoscaler moved shows a node_count change, and azurerm refuses to apply it: "cannot change
  # `node_count` when `auto_scaling_enabled` is set to `true`". That also blocked every other change
  # to the default pool. Ignoring the one attribute leaves the rest of the cluster managed.
  lifecycle {
    ignore_changes = [default_node_pool[0].node_count]
  }
}

################################################################################
# Additional node pools (for extra machine types beyond the first)
################################################################################

resource "azurerm_kubernetes_cluster_node_pool" "extra" {
  count = length(var.machine_types) > 1 ? length(var.machine_types) - 1 : 0

  name                  = "pool${count.index + 1}"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.machine_types[count.index + 1]
  vnet_subnet_id        = var.vnet_subnet_id
  os_disk_size_gb       = var.disk_size_gb
  os_disk_type          = var.os_disk_type
  node_count            = var.node_desired_size
  min_count             = var.node_min_size
  max_count             = var.node_max_size
  auto_scaling_enabled  = true
  max_pods              = 110

  # A vm_size change (a new size at this position of aks_instance_types), or a change to the OS
  # disk, max_pods or subnet, cycles the pool through this temporary pool instead of failing the
  # apply (#5578). Adding it to a live pool is an update in place that moves no node.
  temporary_name_for_rotation = local.rotation_names["pool${count.index + 1}"]

  # node_labels (#5535): null when none were set, so these pools plan exactly as before. They take
  # none of the user's taints: those go to the named pools only (node-pool contract #5533).
  node_labels = local.node_labels_argument

  tags = local.common_tags

  # Every positional pool is autoscaled (auto_scaling_enabled above is fixed at true), so the
  # autoscaler owns the count once the pool exists (#5578). node_count is where the pool STARTS;
  # without this, every plan after the autoscaler moved would send the pool back to
  # aks_node_desired_size.
  lifecycle {
    ignore_changes = [node_count]
  }
}

################################################################################
# Named node pools (#5535): extra_node_pools at the root, one per NAME
################################################################################
# Keyed by name with for_each, never by position like `extra` above: removing a pool from the
# middle of the list removes that pool and leaves every other one alone. Each has its own vm_size
# and sizes. Isolation parity (#5533): the same subnet, OS disk size and type, and max_pods as the
# default pool, so a pool is never cheaper because it is less isolated. Labels and taints arrive
# already mapped by the root (nodepools.tf), the Spot label and taint included.
resource "azurerm_kubernetes_cluster_node_pool" "named" {
  for_each = var.named_node_pools

  name                  = each.key
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  mode                  = "User"
  vm_size               = each.value.vm_size

  # A vm_size change CYCLES the pool through this temporary pool instead of failing: azurerm
  # creates it, moves the workload off, rebuilds the pool on the new size and deletes it again.
  # The name is derived from the pool's own, inside AKS's 12-character pool-name rule: up to six
  # characters of the name (which starts with a letter) plus six hex characters of its hash, so
  # two pools never share one and none collides with a reserved name.
  temporary_name_for_rotation = "${substr(each.key, 0, min(6, length(each.key)))}${substr(md5(each.key), 0, 6)}"
  vnet_subnet_id              = var.vnet_subnet_id
  os_disk_size_gb             = var.disk_size_gb
  os_disk_type                = var.os_disk_type
  max_pods                    = 110

  auto_scaling_enabled = true
  node_count           = each.value.node_count
  min_count            = each.value.min_count
  max_count            = each.value.max_count

  # ForceNew: changing capacity_type replaces the pool. Null on on-demand pools, so they render no
  # spot argument at all. A Spot pool uses the cluster's Spot settings (aks_spot_eviction_policy,
  # aks_spot_max_price at the root), the same ones the `spot` pool below uses.
  priority        = each.value.spot ? "Spot" : null
  eviction_policy = each.value.spot ? var.spot_eviction_policy : null
  spot_max_price  = each.value.spot ? var.spot_max_price : null

  node_labels = each.value.node_labels
  node_taints = length(each.value.node_taints) > 0 ? each.value.node_taints : null

  tags = local.common_tags

  # The autoscaler owns the node count once the pool exists. node_count (desired_size) is where the
  # pool STARTS; without this, every plan after the autoscaler moved would scale the pool back.
  lifecycle {
    ignore_changes = [node_count]
  }
}

################################################################################
# Spot node pool (aws parity: eks_ng_capacity_type)
################################################################################
# ITS OWN RESOURCE, not a flag on the pools above, and that is forced twice over:
#
#   · `priority`, `eviction_policy` and `spot_max_price` are ForceNew on this resource, so flipping
#     a flag on `extra` would DESTROY AND RECREATE the customer's existing worker pool rather than
#     add capacity beside it.
#   · AKS refuses a Spot default node pool outright ("A Spot node pool can't be a default node
#     pool"), so the system pool has to stay on-demand regardless.
#
# `count = 0` by default, so a cluster that did not ask for Spot plans exactly as it did before.
#
# Azure taints these nodes `kubernetes.azure.com/scalesetpriority=spot:NoSchedule` and labels them
# `kubernetes.azure.com/scalesetpriority=spot` on its own. azurerm documents that a Spot pool must
# declare BOTH, the label in node_labels and the taint in node_taints, and the two differ in how the
# provider reads them back. node_labels is Optional+Computed, so a label the config leaves out is
# not a diff. node_taints is Optional and NOT Computed ("Node Taints ... should not be computed and
# must be specified"), and the provider reads it back from the pool's nodeTaints as AKS reports
# them, so a taint AKS reports there is a diff against a config that leaves it out. The provider's
# own Spot acceptance tests declare it for that reason. The pool therefore declares the taint
# always (#5578), and the label once node_labels is set (#5535). In azurerm 4.x node_taints is neither ForceNew nor a property that cycles the pool:
# it updates the pool in place.
resource "azurerm_kubernetes_cluster_node_pool" "spot" {
  count = var.spot_enabled ? 1 : 0

  name                  = "spot"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.machine_types[0]
  vnet_subnet_id        = var.vnet_subnet_id
  os_disk_size_gb       = var.disk_size_gb
  os_disk_type          = var.os_disk_type

  priority        = "Spot"
  eviction_policy = var.spot_eviction_policy
  spot_max_price  = var.spot_max_price

  # `min_count = 0` is the point of the pool: interruptible capacity you stop paying for when there
  # is no work. `node_count` is deliberately the MINIMUM and not the on-demand pools' desired size —
  # a Spot pool that starts at the on-demand headcount is a bill, not a saving.
  auto_scaling_enabled = true
  node_count           = var.spot_node_min_size
  min_count            = var.spot_node_min_size
  max_count            = var.spot_node_max_size
  max_pods             = 110

  # node_labels (#5535): null when none were set, so the pool plans exactly as before. When set,
  # the Spot label AKS puts on these nodes itself is declared beside them, as azurerm requires of a
  # Spot pool that declares node_labels at all.
  node_labels = length(var.node_labels) > 0 ? merge(var.node_labels, { "kubernetes.azure.com/scalesetpriority" = "spot" }) : null

  # The taint AKS puts on every Spot node, declared so the plan matches the pool AKS reports (see
  # the block comment above). It adds nothing to a node: AKS tainted these nodes when it made them.
  # It is not one of the user's taints; those go to the named pools only.
  node_taints = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]

  # A vm_size change (a new first entry in aks_instance_types), or a change to the OS disk or
  # subnet, cycles the pool through this temporary pool instead of failing the apply (#5578).
  # Adding it to a live pool is an update in place that moves no node.
  temporary_name_for_rotation = local.rotation_names["spot"]

  tags = local.common_tags

  # Autoscaled from aks_spot_node_min_size, which is also where it STARTS. Once the autoscaler adds
  # a node, every plan would otherwise send the pool back to the minimum (#5578).
  lifecycle {
    ignore_changes = [node_count]
  }
}

################################################################################
# Runner cluster-admin (BYOC AZ-SELF-ADMIN — mirror of EKS #470)
################################################################################

# The runner reaches AKS via its OWN AAD (workload-identity) token; with Azure RBAC for
# Kubernetes enabled on the cluster above, that token is unauthorized (401 → ArgoCD/kubectl
# fail) unless the apply identity holds an RBAC role. Grant the CURRENT apply principal
# (data.azurerm_client_config.current = the runner's own identity — no Graph read, no extra
# input) cluster-admin at the cluster scope so it can install ArgoCD + add-ons. Gated by
# enable_creator_admin (default true); when off, the top-level checks.tf guard requires an
# admin_group_object_ids path instead so the cluster is never left with no runner admin.
data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "runner_cluster_admin" {
  count                = var.enable_creator_admin ? 1 : 0
  scope                = azurerm_kubernetes_cluster.this.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = data.azurerm_client_config.current.object_id
}
