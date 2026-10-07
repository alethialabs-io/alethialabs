#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID to deploy resources into"

  # FAIL CLOSED — same shape as aws_account_id in the aws template. This flows from the same
  # CloudAccountID field (packages/core/cloud/azure_provider.go emits it as `subscription_id`)
  # and the runner resolves it the same way, so the same empty-value hole exists here. It is also
  # the azurerm PROVIDER's subscription, so an empty value fails authentication rather than one
  # resource — with an error that never names the input. Azure subscription ids are UUIDs.
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID. It is empty or malformed — the runner resolves it from the connector's CloudIdentity, or for an ambient-credential runner from $ARM_SUBSCRIPTION_ID."
  }
}

variable "location" {
  type        = string
  description = "Azure region to deploy to"
}

variable "environment" {
  type        = string
  description = "Environment in which the infrastructure is going to be deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

# Per-cloud classification tags emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia:project-id` /
# `alethia:environment-id` sweep handles (colon-namespaced keys). Merged into local.azure_default_tags
# so it lands on every taggable resource; the platform base tags always WIN a key collision (they sit
# on the merge RHS).
variable "classification_tags" {
  type        = map(string)
  description = "Classification + sweep-handle tags to stamp on every taggable resource. Platform base tags override on conflict."
  default     = {}
}

#########################################################################
##                   Network Variables                                 ##
#########################################################################

variable "provision_vnet" {
  type        = bool
  default     = true
  description = "Whether to provision a new Virtual Network"
}

# #1987. ADDITIVE, never restrictive: admitted alongside the template's own NSG rules, so the empty
# default is behaviour-preserving and cannot lock the external runner out of a cluster it still has
# to provision. Read by modules/vnet's azurerm_network_security_group.private.
variable "vnet_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "Extra source CIDRs permitted inbound to this VNet's private subnet, on top of the template's own rules. Empty (the default) adds nothing."

  validation {
    # alltrue([]) is true, so the empty default passes without a special case.
    condition     = alltrue([for c in var.vnet_allowed_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "vnet_allowed_cidr_blocks must all be valid CIDRs (e.g. 10.1.0.0/16)."
  }
}

variable "vnet_cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "Primary CIDR range for the Virtual Network"

  validation {
    condition     = can(cidrhost(var.vnet_cidr, 0))
    error_message = "vnet_cidr must be a valid IPv4 CIDR, e.g. 10.0.0.0/16."
  }
}

variable "vnet_id" {
  type        = string
  default     = ""
  description = "Resource ID of an existing Virtual Network (used when provision_vnet = false)"
}

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "User-selected subnets within the existing VNet — bare names or full ARM subnet ids (brownfield, provision_vnet = false, #1352). Empty = use the VNet's first (arbitrary) subnet. Only the first entry is used (AKS attaches to one subnet)."
}

variable "single_nat_gateway" {
  type        = bool
  default     = false
  description = "Whether to use a single NAT Gateway instead of one per zone. Suitable for dev/test environments"
}

#########################################################################
##                   AKS Variables                                     ##
#########################################################################

variable "provision_aks" {
  type        = bool
  default     = true
  description = "Whether to provision an AKS cluster"
}

variable "aks_cluster_version" {
  type = string
  # 1.31's latest patch is now LTS-only on AKS, so a bare "1.31" fails a fresh apply with
  # K8sVersionNotSupported (verified on real AKS). Pin a current STANDARD-support minor.
  # NOTE: the managed path sets this from the catalog SSOT (catalog.json); this default is the
  # BYO-IaC fallback only. Keep both on the same standard minor.
  default     = "1.35"
  description = "Desired Kubernetes version for the AKS cluster (must be a STANDARD-support minor; LTS-only minors need LTS enabled)"
}

variable "aks_instance_types" {
  # Equal to the catalog default (packages/core/catalog/catalog.json compute.azure.default_instance)
  # by rule: TestTemplateNodeDefaultsEqualTheCatalog fails when they differ (#5266).
  type        = list(string)
  default     = ["Standard_D2s_v5"]
  description = "VM sizes for the AKS default node pool"

  validation {
    condition     = length(var.aks_instance_types) > 0
    error_message = "aks_instance_types must list at least one VM size."
  }
}

variable "aks_node_min_size" {
  type        = number
  default     = 1
  description = "Minimum number of nodes in the AKS node pool"
}

variable "aks_node_max_size" {
  type        = number
  default     = 5
  description = "Maximum number of nodes in the AKS node pool"

  validation {
    condition     = var.aks_node_max_size >= var.aks_node_min_size
    error_message = "aks_node_max_size must be >= aks_node_min_size."
  }
}

variable "aks_node_desired_size" {
  type        = number
  default     = 2
  description = "Initial/desired number of nodes in the AKS node pool"
}

variable "aks_disk_size_gb" {
  type        = number
  default     = 100
  description = "Size of the OS disk attached to each AKS node (GB)"

  validation {
    condition     = var.aks_disk_size_gb >= 30
    error_message = "aks_disk_size_gb must be at least 30 GB (Azure OS-disk minimum)."
  }
}

# ⚠️ NOT the analogue of aws's eks_volume_type, and the description says so on purpose. AKS gives no
# OS-disk SKU and no OS-disk IOPS at all — neither azurerm 4.81.0's agent-pool schema nor the ARM
# `agentPools` reference carries either, because AKS derives the OS disk from the VM size you pick.
# What Azure DOES let you choose is where the disk LIVES: Managed (a durable attached disk) or
# Ephemeral (the VM's local storage — faster, free, and lost on reimage). Calling this a disk-type
# knob and moving on would have marked a parity cell green for a different feature.
#
# Null, not "Managed": the attribute is optional and NOT computed, so a null renders no argument at
# all — byte-identical to the config that shipped before this variable existed. "Managed" is the
# Azure default and would almost certainly plan the same, but "almost certainly" is not a claim
# worth making about every existing cluster when null makes it by construction.
variable "aks_os_disk_type" {
  type        = string
  default     = null
  description = "Where each AKS node's OS disk lives: \"Managed\" (durable attached disk) or \"Ephemeral\" (VM-local storage — faster and free, but reset on reimage and capped by the VM size's cache). Null (the default) leaves Azure's own default, Managed."

  # `coalesce` to a valid member rather than `var.x == null || contains(…)`. OpenTofu does NOT
  # short-circuit `||` inside a validation condition, so the right-hand side is evaluated even when
  # the left is true, and `contains(list, null)` is an "Invalid function argument" error rather than
  # a false. The guard then fails on the DEFAULT, which is the one input it must accept.
  validation {
    condition     = contains(["Managed", "Ephemeral"], coalesce(var.aks_os_disk_type, "Managed"))
    error_message = "aks_os_disk_type must be \"Managed\", \"Ephemeral\", or null."
  }
}

# ── Spot node pool (aws parity: eks_ng_capacity_type) ────────────────────────────────────────────
# Spot on AKS is a SEPARATE NODE POOL, never a flag on an existing one, and that is not a style
# choice: `priority`, `eviction_policy` and `spot_max_price` are ForceNew on
# azurerm_kubernetes_cluster_node_pool, and Microsoft's own documented limitation is that a Spot
# pool cannot be the default node pool. Off by default, so an existing cluster's plan is unchanged.
variable "aks_spot_enabled" {
  type        = bool
  default     = false
  description = "Add a Spot node pool alongside the on-demand pools. Spot nodes are evictable at any time, so the system pool stays on-demand and workloads must tolerate the kubernetes.azure.com/scalesetpriority=spot taint Azure applies."
}

variable "aks_spot_max_price" {
  type        = number
  default     = -1
  description = "Hourly ceiling (USD) for a Spot node. -1 (the default) means pay up to the on-demand price and never get evicted on price alone — only on capacity. Applies to the Spot pool and to every extra_node_pools pool with capacity_type spot."

  validation {
    condition     = var.aks_spot_max_price == -1 || var.aks_spot_max_price > 0
    error_message = "aks_spot_max_price must be -1 (pay up to on-demand) or a positive hourly price."
  }
}

variable "aks_spot_eviction_policy" {
  type        = string
  default     = "Delete"
  description = "What Azure does to a reclaimed Spot node: \"Delete\" (the default — the node is removed and the autoscaler replaces it) or \"Deallocate\" (the node is stopped but its quota is held). Applies to the Spot pool and to every extra_node_pools pool with capacity_type spot."

  validation {
    condition     = contains(["Delete", "Deallocate"], var.aks_spot_eviction_policy)
    error_message = "aks_spot_eviction_policy must be \"Delete\" or \"Deallocate\"."
  }
}

variable "aks_spot_node_min_size" {
  type        = number
  default     = 0
  description = "Minimum nodes in the Spot pool. 0 (the default) lets the pool scale to nothing when there is no work for it, which is the point of buying interruptible capacity."

  validation {
    condition     = var.aks_spot_node_min_size >= 0
    error_message = "aks_spot_node_min_size must be 0 or greater."
  }
}

variable "aks_spot_node_max_size" {
  type        = number
  default     = 3
  description = "Maximum nodes in the Spot pool. Only read when aks_spot_enabled is true."

  validation {
    condition     = var.aks_spot_node_max_size >= 1
    error_message = "aks_spot_node_max_size must be at least 1."
  }
}

# BYOC AZ-SELF-ADMIN (mirror of EKS #470): grant the apply/runner identity RBAC Cluster
# Admin on the AKS cluster so it can install ArgoCD/add-ons over its own AAD token. Default
# true. Turning it off requires aks_admin_group_object_ids (enforced by checks.tf below).
variable "aks_enable_creator_admin" {
  type        = bool
  default     = true
  description = "Grant the apply/runner identity 'Azure Kubernetes Service RBAC Cluster Admin' at cluster scope (default true). Without it (and no admin group) the runner cannot install ArgoCD."
}

# BYOC B4.1: Entra group OBJECT IDs (GUIDs, not names) granted cluster-admin via AKS
# AAD-integrated RBAC. Sourced from the project's cluster_admins (each admin's `groups`
# hold Entra group object IDs). Empty (default) = no customer admin group (the runner
# still gets admin via aks_enable_creator_admin).
variable "aks_admin_group_object_ids" {
  type        = list(string)
  default     = []
  description = "Entra group object IDs mapped to the AKS cluster admin_group_object_ids. Empty leaves AAD admin-group integration off (unchanged)."
}

# BYOC B4.1: CIDRs allowed to reach the AKS public API server. Empty (default) leaves
# the API server open to all source IPs so the external runner can still provision.
variable "aks_authorized_ip_ranges" {
  type        = list(string)
  default     = []
  description = "CIDRs allow-listed on the AKS public API server (api_server_access_profile.authorized_ip_ranges). Empty = open to all (unchanged)."
}

# Control-plane log retention (CUSTOMIZABILITY-PARITY top gap #1; aws parity:
# eks_cloudwatch_log_group_retention_in_days). Null (default) creates NOTHING — no Log Analytics
# workspace, no oms_agent, no diagnostic setting — so every existing cluster plans unchanged and
# nobody starts paying for ingestion they did not ask for. Set, it creates one workspace with this
# retention, points the AKS monitoring add-on at it, and ships kube-apiserver + kube-audit-admin
# there. See aks.tf. A workspace bills per GB ingested.
variable "aks_log_retention_days" {
  type        = number
  default     = null
  description = "Days to keep AKS control-plane logs (kube-apiserver, kube-audit-admin) in a Log Analytics workspace this template creates. 30-730. Null = no workspace and no log shipping (unchanged). Billed per GB ingested."

  validation {
    # Log Analytics' PerGB2018 tier accepts 30-730 days; anything outside fails at apply with an
    # error that names the workspace, not this knob.
    #
    # try(), not `null ? … : …` or `== null || …`: neither operator short-circuits on the runner's
    # tofu 1.9 (#1931), so a comparison against null would error instead of passing. A null makes
    # the first argument fail, and the fallback then answers "is it null" — true only for null.
    condition     = try(var.aks_log_retention_days >= 30 && var.aks_log_retention_days <= 730 && floor(var.aks_log_retention_days) == var.aks_log_retention_days, var.aks_log_retention_days == null)
    error_message = "aks_log_retention_days must be a whole number of days from 30 to 730 (the Log Analytics PerGB2018 range), or null to ship no control-plane logs."
  }
}

#########################################################################
##                   Azure DB Variables                                ##
#########################################################################

variable "create_azure_db" {
  type        = bool
  default     = false
  description = "Whether to create an Azure Database flexible server"
}

variable "azure_db_engine" {
  type        = string
  default     = "postgres"
  description = "Database engine type (postgres or mysql)"
}

variable "azure_db_engine_version" {
  type        = string
  default     = "16"
  description = "Database engine version"
}

variable "azure_db_sku_name" {
  type        = string
  default     = "B_Standard_B1ms"
  description = "SKU name for the Azure Database flexible server"
}

variable "azure_db_storage_mb" {
  type        = number
  default     = 32768
  description = "Maximum storage size in MB for the Azure Database flexible server"
}

variable "azure_db_high_availability" {
  type        = bool
  default     = false
  description = "Whether to enable high availability for the Azure Database instance"
}

variable "azure_db_backup_retention_days" {
  type        = number
  default     = 7
  description = "Number of days to retain Azure Database backups"
}

variable "azure_db_port" {
  type        = number
  default     = 5432
  description = "Port number for the Azure Database instance"
}

variable "azure_db_iam_auth" {
  type        = bool
  default     = false
  description = "Whether to enable Azure Active Directory (AAD) authentication on the Flexible Server"
}

# BYOC B4.1: source CIDRs allow-listed on the DB public endpoint (one firewall rule
# each). Empty (default) creates no rules — the server stays private (VNet-integrated),
# unchanged. Applies to the public endpoint only (see azure-db module).
variable "azure_db_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Source CIDRs allow-listed on the Azure DB public endpoint. Empty = no firewall rules, server stays private (unchanged)."
}

# DB log exports (CUSTOMIZABILITY-PARITY top gap #5; aws parity: rds_enabled_cloudwatch_logs_exports).
# Empty (default) creates no diagnostic setting. The categories are the flexible server's own log
# categories, and they differ by engine — the engine match is enforced at plan in azure-db.tf,
# because a variable validation here may not read azure_db_engine on the runner's tofu.
variable "azure_db_log_exports" {
  type        = list(string)
  default     = []
  description = "Flexible Server log categories to ship to Log Analytics. PostgreSQL: PostgreSQLLogs, PostgreSQLFlexSessions, PostgreSQLFlexQueryStoreRuntime, PostgreSQLFlexQueryStoreWaitStats, PostgreSQLFlexTableStats, PostgreSQLFlexDatabaseXacts. MySQL: MySqlSlowLogs, MySqlAuditLogs. Empty = no log shipping (unchanged). Billed per GB ingested."

  validation {
    condition = alltrue([for c in var.azure_db_log_exports : contains([
      "PostgreSQLLogs", "PostgreSQLFlexSessions", "PostgreSQLFlexQueryStoreRuntime",
      "PostgreSQLFlexQueryStoreWaitStats", "PostgreSQLFlexTableStats", "PostgreSQLFlexDatabaseXacts",
      "MySqlSlowLogs", "MySqlAuditLogs",
    ], c)])
    error_message = "azure_db_log_exports accepts only Flexible Server log categories. PostgreSQL: PostgreSQLLogs, PostgreSQLFlexSessions, PostgreSQLFlexQueryStoreRuntime, PostgreSQLFlexQueryStoreWaitStats, PostgreSQLFlexTableStats, PostgreSQLFlexDatabaseXacts. MySQL: MySqlSlowLogs, MySqlAuditLogs."
  }

  validation {
    condition     = length(distinct(var.azure_db_log_exports)) == length(var.azure_db_log_exports)
    error_message = "azure_db_log_exports lists a category twice; a diagnostic setting accepts each category once."
  }
}

# Where azure_db_log_exports go when this template is not creating a workspace (aks_log_retention_days
# unset). A full Log Analytics workspace resource id. Empty + no template workspace + a non-empty
# azure_db_log_exports is REFUSED at plan (azure-db.tf), never silently skipped.
variable "azure_db_log_workspace_id" {
  type        = string
  default     = ""
  description = "Resource id of an existing Log Analytics workspace to receive azure_db_log_exports. Required when azure_db_log_exports is set and aks_log_retention_days is not; ignored when the template creates its own workspace."

  validation {
    condition     = var.azure_db_log_workspace_id == "" || can(regex("(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.OperationalInsights/workspaces/[^/]+$", var.azure_db_log_workspace_id))
    error_message = "azure_db_log_workspace_id must be a Log Analytics workspace resource id: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name>."
  }
}

# Server parameters (CUSTOMIZABILITY-PARITY top gap #7; gcp parity: cloud_sql_database_flags). One
# *_flexible_server_configuration per entry, for whichever engine is provisioned. Empty (default)
# creates none. Parameters that could switch transport encryption off or down are refused here,
# not left to the server to accept.
variable "azure_db_database_flags" {
  type        = map(string)
  default     = {}
  description = "Flexible Server parameters as name = value, e.g. { max_connections = \"200\", log_min_duration_statement = \"500\" }. Applied to whichever engine is provisioned. TLS parameters (require_secure_transport, ssl_min_protocol_version, tls_version) are refused. Empty = server defaults (unchanged)."

  validation {
    condition     = alltrue([for k in keys(var.azure_db_database_flags) : can(regex("^[a-z][a-z0-9_.]*$", k))])
    error_message = "azure_db_database_flags keys must be server parameter names: lowercase letters, digits, '_' and '.', starting with a letter (e.g. max_connections, pg_qs.query_capture_mode)."
  }

  validation {
    # Refused by NAME, not by value: the only values worth setting on these weaken the server
    # (require_secure_transport=OFF, a TLS 1.0/1.1 floor), and the defaults are already the strict
    # ones. A user who needs one of them changes it with eyes open, outside this template.
    condition     = length(setintersection(toset(keys(var.azure_db_database_flags)), toset(["require_secure_transport", "ssl_min_protocol_version", "tls_version"]))) == 0
    error_message = "azure_db_database_flags may not set require_secure_transport, ssl_min_protocol_version or tls_version: each can turn TLS off or allow TLS below 1.2 on the database. The server defaults already require TLS 1.2."
  }
}

#########################################################################
##                   Azure Cache (Redis) Variables                     ##
#########################################################################

variable "create_azure_cache" {
  type        = bool
  default     = false
  description = "Whether to create an Azure Cache for Redis instance"
}

variable "azure_cache_sku" {
  type        = string
  default     = "Basic"
  description = "SKU for Azure Cache for Redis (Basic, Standard, or Premium)"
}

# azure_cache_redis_version was here. DELETED, not left declared (#1993): Azure Cache for Redis is
# retired and the kind is backed by azurerm_managed_redis, which accepts NO engine-version argument
# — neither `redis_version` on the resource nor `version` inside `default_database`. Both were
# probed against the pinned provider and both are "Unsupported argument".
#
# A variable nobody can honor is worse than no variable: it reads as a setting, and it manufactures
# a false green in the parity guards, which ask whether a tfvar is DECLARED and read.
#
# azure_cache_family ("C"/"P") and azure_cache_capacity (0-6) were here too, and were DELETED by
# #4320 for exactly the reason stated above, one paragraph up. They are the two halves of the
# RETIRED azurerm_redis_cache sku block (`sku { name, family, capacity }`). azurerm_managed_redis
# has a single flat `sku_name` — Balanced_B0, MemoryOptimized_M10, and so on — and no family or
# capacity argument for them to reach; the family/capacity pair cannot even be folded into it,
# because `azure_cache_sku`/`azure_cache_sku_name` already choose that one string and a second
# mapping over the same field would just be a way for two knobs to disagree.
#
# Both were declared and reachable and read by nothing (the `dead:` backlog in
# infra/templates/project/knob-exclusions.yaml) since the Managed Redis migration. Nothing emits
# them — no Go provider, no tfvars, no test — so deleting is a removal of an offer that was never
# real, and #1993 is the recorded precedent for this exact shape on this exact resource.

variable "azure_cache_multi_az" {
  type        = bool
  default     = false
  description = "Whether to enable zone redundancy for Azure Cache for Redis (requires Premium SKU)"
}

# Cache logging (CUSTOMIZABILITY-PARITY top gap #9; aws parity: the ElastiCache log delivery
# configuration). Empty (default) creates no diagnostic setting. Same destination rule as
# azure_db_log_exports: the template's workspace when aks_log_retention_days created one, otherwise
# azure_cache_log_workspace_id, otherwise refused at plan.
variable "azure_cache_log_categories" {
  type        = list(string)
  default     = []
  description = "Azure Managed Redis diagnostic log categories to ship to Log Analytics. Accepted: ConnectionEvents. Empty = no log shipping (unchanged). Billed per GB ingested."

  validation {
    # Microsoft.Cache/redisEnterprise/databases exposes exactly one log category. The list shape is
    # kept so a category Azure adds later is a validation change, not a type change.
    condition     = alltrue([for c in var.azure_cache_log_categories : contains(["ConnectionEvents"], c)])
    error_message = "azure_cache_log_categories accepts only ConnectionEvents, the one log category Azure Managed Redis emits."
  }

  validation {
    condition     = length(distinct(var.azure_cache_log_categories)) == length(var.azure_cache_log_categories)
    error_message = "azure_cache_log_categories lists a category twice; a diagnostic setting accepts each category once."
  }
}

variable "azure_cache_log_workspace_id" {
  type        = string
  default     = ""
  description = "Resource id of an existing Log Analytics workspace to receive azure_cache_log_categories. Required when azure_cache_log_categories is set and aks_log_retention_days is not; ignored when the template creates its own workspace."

  validation {
    condition     = var.azure_cache_log_workspace_id == "" || can(regex("(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.OperationalInsights/workspaces/[^/]+$", var.azure_cache_log_workspace_id))
    error_message = "azure_cache_log_workspace_id must be a Log Analytics workspace resource id: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name>."
  }
}

#########################################################################
##                   Service Bus Variables                             ##
#########################################################################

variable "create_service_bus" {
  type        = bool
  default     = false
  description = "Whether to create an Azure Service Bus namespace"
}

variable "service_bus_sku" {
  type        = string
  default     = "Standard"
  description = "SKU for the Service Bus namespace (Basic, Standard, or Premium)"
}

variable "service_bus_queues" {
  type        = map(any)
  default     = {}
  description = "Map of Service Bus queues to create"
}

variable "service_bus_topics" {
  type        = map(any)
  default     = {}
  description = "Map of Service Bus topics to create"
}

#########################################################################
##                   Cosmos DB Variables                               ##
#########################################################################

variable "create_cosmos_db" {
  type        = bool
  default     = false
  description = "Whether to create an Azure Cosmos DB account"
}

variable "cosmos_db_kind" {
  type        = string
  default     = "GlobalDocumentDB"
  description = "Kind of Cosmos DB account (GlobalDocumentDB or MongoDB)"
}

variable "cosmos_db_consistency_level" {
  type        = string
  default     = "Session"
  description = "Default consistency level for the Cosmos DB account"
}

variable "cosmos_db_collections" {
  type = list(object({
    name          = string
    partition_key = optional(string, "/id")
    # No `billing_mode` (#4320, maintainer ruling 2026-09-23): Cosmos here is SERVERLESS ONLY. Throughput
    # is bought per ACCOUNT, so a per-container billing mode had nothing to land on and a user who
    # picked provisioned silently got serverless. Replica regions are the one route to provisioned
    # throughput (see `local.cosmos_replica_regions` in cosmos-db.tf). An old tfvars still carrying the
    # key is harmless: tofu drops object attributes the declared type omits.
    # Point-in-time restore. Offered per table by the canvas, but Cosmos buys it per ACCOUNT (the
    # `backup` block below), so any container asking for it puts the whole account in continuous
    # backup mode — see `local.cosmos_backup_type` in cosmos-db.tf.
    point_in_time_recovery = optional(bool, false)
    # Synapse Link analytical (column) storage. A SEPARATE, separately-billed feature that is not a
    # backup: the canvas offers no switch for it, and nothing derives it from point_in_time_recovery
    # any more (#1838). Kept accepted so a tenant driving the tfvars directly can still ask for it.
    analytical_storage_enabled = optional(bool, false)
    # Replica regions (#2158). Offered per table by the canvas, but Cosmos replicates per ACCOUNT
    # (`geo_location` blocks), so the account gets the UNION of every table's list — the
    # point_in_time_recovery shape above, one row up. A non-empty union also switches the account
    # off serverless (single-region-only) onto provisioned throughput — see
    # `local.cosmos_replica_regions` in cosmos-db.tf for both derivations.
    global_replicas = optional(list(string), [])
  }))
  default     = []
  description = "List of Cosmos DB containers (collections) to create with partition keys"
}

variable "cosmos_db_continuous_backup_tier" {
  type        = string
  default     = "Continuous7Days"
  description = "Retention tier used when a container asks for point-in-time recovery. Continuous7Days is free; Continuous30Days is billed."

  validation {
    condition     = contains(["Continuous7Days", "Continuous30Days"], var.cosmos_db_continuous_backup_tier)
    error_message = "cosmos_db_continuous_backup_tier must be Continuous7Days or Continuous30Days."
  }
}

#########################################################################
##                   Azure DNS Variables                               ##
#########################################################################

variable "azure_dns_enabled" {
  type        = bool
  default     = false
  description = "Whether to create an Azure DNS zone"
}

variable "azure_dns_zone_name" {
  type        = string
  default     = ""
  description = "Name of the Azure DNS zone"
}

variable "azure_dns_domain" {
  type        = string
  default     = ""
  description = "DNS domain name for the managed zone"
}


#########################################################################
##                   Azure WAF Variables                               ##
#########################################################################

variable "azure_waf_enabled" {
  type        = bool
  default     = false
  description = "Whether to create an Azure WAF policy"
}

variable "azure_waf_rules" {
  type = list(object({
    priority         = number
    rule_type        = string
    action           = string
    match_conditions = optional(list(any), [])
  }))
  default     = []
  description = "List of Azure WAF custom rules"
}

#########################################################################
##            Application Gateway / AGIC Variables                     ##
#########################################################################

variable "azure_application_gateway_enabled" {
  type        = bool
  default     = null
  description = <<-EOT
    Whether to provision an Application Gateway v2 (and, on a cluster, the Application Gateway
    Ingress Controller that drives it from Kubernetes Ingress objects).

    Leave UNSET (null, the default) to follow `azure_waf_enabled`: on Azure a WAF policy binds to
    an Application Gateway and to nothing else, so a WAF with no gateway inspects no requests.
    Set true to get the ingress without a WAF; set false to keep neither.

    COST: a v2 gateway bills per hour for as long as it exists, independently of traffic and of
    whether any Ingress object was ever created — materially more than the WAF policy itself.
    Requires `provision_vnet = true`; the gateway needs a dedicated subnet, which only the VNet
    this template creates can carve.
  EOT
}

variable "azure_application_gateway_capacity" {
  type        = number
  default     = 1
  description = "Fixed instance count for the Application Gateway v2 SKU. Azure requires at least 1; raise it for capacity or zone redundancy."

  validation {
    condition     = var.azure_application_gateway_capacity >= 1 && var.azure_application_gateway_capacity <= 125
    error_message = "azure_application_gateway_capacity must be between 1 and 125 (the Application Gateway v2 instance-count range)."
  }
}

#########################################################################
##                   Storage Account Variables                         ##
#########################################################################

variable "create_storage_account" {
  type        = bool
  default     = false
  description = "Whether to create an Azure Storage Account"
}

variable "storage_account_tier" {
  type        = string
  default     = "Standard"
  description = "Performance tier for the Storage Account (Standard or Premium)"
}

variable "storage_account_replication" {
  type        = string
  default     = "LRS"
  description = "Replication type for the Storage Account (LRS, GRS, RAGRS, ZRS)"
}

# Typed, not `list(any)`. Under `any` this variable accepted every spelling and forwarded it to a
# module that declares a real object type, which discards whatever it does not name — so the
# provider spent months sending `container_access_type` into a void with nothing able to say so.
variable "storage_containers" {
  type = list(object({
    name        = string
    access_type = optional(string, "private")
    # Per container because that is how it is chosen; applied per ACCOUNT because that is the only
    # scope azurerm offers. modules/storage-account/main.tf carries the aggregation and the reason.
    versioning_enabled = optional(bool, false)
    # CMEK (CUSTOMIZABILITY-PARITY top gap #8). The same per-container/per-account split as
    # versioning: encryption is a property of the ACCOUNT, so any container asking for it encrypts
    # the whole account under a key in this project's Key Vault. See storage-account.tf.
    cmek_enabled = optional(bool, false)
    # Browser origins allowed to call the account's blob endpoint (#5543). The same per-container/
    # per-account split again: CORS is the account's blob_properties.cors_rule, so the lists are
    # UNIONED into one rule in modules/storage-account. The default `[]` is what the module has
    # always filled in, so a container that sets nothing plans no rule, as before.
    #
    # Declared HERE as well as on the module because an object type discards every attribute it
    # does not name. Without this line the provider's per-bucket value was dropped at the root
    # without an error, and the module's own optional() then filled in [].
    cors_origins = optional(list(string), [])
  }))
  default     = []
  description = "List of storage containers to create in the Storage Account. `cmek_enabled` on any container encrypts the whole account with a customer-managed key in the project's Key Vault (requires key_vault_purge_protection_enabled). `cors_origins` from every container are unioned into the account's one blob CORS rule."

  # An origin is a scheme, a host and an optional port — nothing after it. Azure Storage matches the
  # browser's Origin header against these strings exactly, so `https://app.example.com/` (a path),
  # `app.example.com` (no scheme) or an ftp:// URL is accepted by the API and then matches no
  # browser ever: the rule exists and CORS still fails. Refusing it at plan names the value.
  # `*` is allowed, and on Azure it opens the WHOLE storage account to every origin, because the
  # rule is the account's (see modules/storage-account) — the docs say so.
  validation {
    condition = alltrue(flatten([
      for c in var.storage_containers : [
        for o in c.cors_origins : o == "*" || can(regex("^https?://[^/?#[:space:]]+$", o))
      ]
    ]))
    error_message = "Each storage_containers[*].cors_origins entry must be `*` or an absolute http:// or https:// origin with no path, query or trailing slash (for example https://app.example.com or http://localhost:3000)."
  }

  # Azure Storage allows at most 64 origins on a CORS rule, and the account has ONE rule holding the
  # union of every container's origins (modules/storage-account). Over the limit, the API refuses the
  # whole account update at apply; this refuses it at plan, counting what the union will hold.
  validation {
    condition     = length(distinct(flatten([for c in var.storage_containers : c.cors_origins]))) <= 64
    error_message = "Azure allows at most 64 CORS origins on a storage account, and every container's cors_origins are combined into the account's one rule. Remove origins until the containers list at most 64 distinct ones in total."
  }
}

#########################################################################
##                   ACR Variables                                     ##
#########################################################################

variable "provision_acr" {
  type        = bool
  default     = false
  description = "Whether to provision an Azure Container Registry"
}

variable "acr_sku" {
  type        = string
  default     = "Basic"
  description = "SKU for the Azure Container Registry (Basic, Standard, or Premium)"
}

#########################################################################
##                   Secret / Key Vault Variables                      ##
#########################################################################

variable "custom_secrets" {
  type = list(object({
    name          = string
    generate      = bool
    length        = optional(number, 32)
    special_chars = optional(bool, true)
  }))
  default     = []
  description = "List of secrets to create in Azure Key Vault"
}

# Parity with aws (custom_secrets.tf) and gcp (secret-manager.tf): the ONLY lever random_password
# offers for re-generating a value it has already produced. Without it an Azure project's generated
# secrets are immutable for the life of the vault entry — rotation would mean destroying the secret.
variable "custom_secret_keepers" {
  type        = map(map(string))
  default     = {}
  description = "Per-secret rotation keepers, keyed by secret name. Changing any value under a name re-generates that secret's password; a name absent from the map keeps its value forever. Empty (the default) is behavior-preserving."
}

variable "key_vault_purge_protection_enabled" {
  type    = bool
  default = true
  # DEFAULT `true` IS DELIBERATE AND IS NOT AN ENDORSEMENT. Purge protection cannot be disabled
  # once applied, so any other default fails the next `tofu apply` on every environment that
  # already exists. The default preserves them bit-for-bit; the variable is what makes the setting
  # reachable at all, for a new environment or an e2e-shaped one that should not leave a vault name
  # reserved and unpurgeable for seven days after its own teardown.
  description = "Block purging this project's soft-deleted Key Vault until the retention window expires. IRREVERSIBLE: Azure refuses to disable purge protection once it is on, so this can only be set to false BEFORE the vault is first created. Leaving it true means a destroyed environment cannot be rebuilt under the same project + environment name for 7 days."
}

#########################################################################
##                   Custom Terraform Variables                        ##
#########################################################################

variable "custom_iac_vars" {
  type        = any
  default     = {}
  description = "Object of custom values that can be used for extra terraform files outside of the template"
}

variable "azure_cache_sku_name" {
  type    = string
  default = null
  # Exact Azure Managed Redis sku — Balanced_B* / MemoryOptimized_M* / ComputeOptimized_X* /
  # FlashOptimized_A*. (The Enterprise_*/EnterpriseFlash_* families named here previously belong to
  # the older redisEnterprise shape and are NOT what azurerm_managed_redis takes.) When null, the
  # legacy azure_cache_sku (Basic/Standard/Premium) is MAPPED onto Balanced_B0/B1/B3 by
  # azure-cache-redis.tf. Normally the control plane emits this from the project's cloud-indifferent
  # MemoryGB, resolved through packages/core/catalog/catalog.json; set it by hand to pin a tier.
  #
  # The floor is NOT the cost cliff this comment once claimed: Balanced_B0 (0.5 GB) is ~$12/mo
  # against the retired Basic C0's ~$15/mo — cheaper, not ~5x. (Azure Retail Prices API, eastus,
  # 2026-07-27, $0.016/hr × 730.)
  description = "Exact Azure Managed Redis sku (Balanced_B*/MemoryOptimized_M*/ComputeOptimized_X*/FlashOptimized_A*). Null = map from azure_cache_sku. Normally emitted from the project's MemoryGB."
}

# ── external-secrets identity adoption ─────────────────────────────────────────
# Set BOTH to run the external-secrets operator as a PRE-EXISTING user-assigned managed identity
# instead of the per-deploy one this template creates.
#
# Why this exists: a cross-subscription Key Vault role assignment in the TARGET subscription binds
# the identity's OBJECT ID, which Azure regenerates on every create — so a pre-applied grant dies
# the moment the identity is recreated, and a stable name does not help. Adopting a standing
# identity lets the target-subscription grant be applied ONCE.
#
# Both empty (the default) preserves the existing behavior exactly. When adopting, the identity must
# already exist and the caller owns its lifecycle: this template federates a credential onto it and
# grants it Key Vault read, but never creates, modifies or destroys the identity itself.
variable "external_secrets_identity_name" {
  description = "OPTIONAL. Name of a pre-existing user-assigned managed identity for the external-secrets operator. Requires external_secrets_identity_resource_group."
  type        = string
  default     = ""
}

variable "external_secrets_identity_resource_group" {
  description = "OPTIONAL. Resource group holding external_secrets_identity_name. Requires external_secrets_identity_name."
  type        = string
  default     = ""
}

# ── KMS etcd encryption for AKS (#2004) ─────────────────────────────────────────────────────────
# ON BY DEFAULT, matching what AWS has always done silently. See secrets-encryption.tf for why this
# also changes the cluster to a user-assigned identity, and what that means for an existing cluster.
variable "aks_secrets_encryption_enabled" {
  type        = bool
  default     = true
  description = "Envelope-encrypt Kubernetes Secrets in etcd under a key in this project's Key Vault. On by default (AWS parity). Requires key_vault_purge_protection_enabled."
}

# ── Node labels, node taints and named node pools (#5535, contract #5533) ─────────────────────────
# The three blocks below are the cross-cloud node-pool contract, copied VERBATIM from
# packages/core/cloud/testdata/nodepool/reference/variables.tf: type, default, nullable and every
# validation. packages/core/cloud/nodepool_azure_test.go (assertNodePoolContract) fails if any of
# them drifts, and packages/core/nodekeys/drift_test.go holds their key/value regexes to the one Go
# definition. How AKS builds them is in nodepools.tf; what AKS adds on top (the instance-type and
# arm64 checks) is in checks_nodepools.tf, so these blocks stay token-equal to the contract.
#
# Defaults ({}, [], []) render the cluster exactly as before: no pool gains a node_labels argument
# and no azurerm_kubernetes_cluster_node_pool.named exists (nodepools.tftest.hcl proves it).

variable "node_labels" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Labels on the nodes of every Alethia-managed pool, the default pool included. A pool's own labels win for the same key. At most 24. Keys whose prefix ends in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io are refused."

  validation {
    condition = length(var.node_labels) <= 24 && alltrue([for k, v in var.node_labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ])
    error_message = "node_labels may hold at most 24 labels. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for k, v in var.node_labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ])
    error_message = "node_labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those labels themselves, and a kubelet refuses to start with them. Use your own prefix, such as example.com/team, or none."
  }
}

variable "node_taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default     = []
  nullable    = false
  description = "Taints on the nodes of every extra pool (not the default pool, which runs the platform's add-ons). A pool's own taint wins for the same key and effect. At most 24. effect is one of NoSchedule, PreferNoSchedule and NoExecute."

  validation {
    condition     = length(var.node_taints) <= 24 && alltrue([for t in var.node_taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in var.node_taints : "${t.key}:${t.effect}"])) == length(var.node_taints)
    error_message = "node_taints may hold at most 24 taints, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ])
    error_message = "node_taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ])
    error_message = "node_taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those taints themselves (alethia.io/arch marks arm64 pools)."
  }
}

variable "extra_node_pools" {
  type = list(object({
    name          = string
    instance_type = string
    min_size      = number
    max_size      = number
    desired_size  = optional(number)
    arch          = optional(string, "amd64")
    capacity_type = optional(string, "on-demand")
    labels        = optional(map(string), {})
    taints = optional(list(object({
      key    = string
      value  = optional(string)
      effect = string
    })), [])
  }))
  default     = []
  nullable    = false
  description = "Node pools beside the default pool. Each has a name, an instance type, min/max/desired sizes, an optional arch (amd64 or arm64) and capacity_type (on-demand or spot), and its own labels and taints. Its nodes carry the label alethia.io/pool=<name>; an arm64 pool also carries the taint alethia.io/arch=arm64:NoSchedule."

  validation {
    condition = length(var.extra_node_pools) <= 10 && length(distinct([for p in var.extra_node_pools : p.name])) == length(var.extra_node_pools) && alltrue([for p in var.extra_node_pools :
      can(regex("^[a-z][a-z0-9]{0,11}$", p.name)) && !contains(["default", "system", "spot"], p.name) && !can(regex("^pool[0-9]+$", p.name))
    ])
    error_message = "extra_node_pools may list at most 10 pools, each with a unique name of 1 to 12 lowercase letters and digits starting with a letter (the AKS pool-name rule, applied on every cloud so the file is portable). The names default, system, spot and pool1, pool2, ... are taken by pools Alethia already makes."
  }

  # A pool may not be named for another pool's temporary_name_for_rotation (#5578). modules/aks
  # derives that name for every pool as up to six characters of its name plus six hex characters of
  # its md5: default -> defaulc21f96, spot -> spotb2e189, pool1 -> pool15934c3. A vm_size or disk
  # change CYCLES a pool through that name: azurerm creates the temporary pool, or ADOPTS one that
  # already exists under the name, and deletes it at the end. A named pool carrying the name would be
  # deleted with its nodes. pool1..pool100 covers every positional pool: AKS caps a cluster at 100
  # node pools. The derivation is restated here because a variable validation can read no local; the
  # tofu test in nodepools.tftest.hcl pins both copies to the same names.
  validation {
    condition = alltrue([for p in var.extra_node_pools : !contains([
      for n in concat(["default", "spot"], [for i in range(1, 101) : "pool${i}"], [for q in var.extra_node_pools : q.name if q.name != p.name]) :
      "${substr(n, 0, min(6, length(n)))}${substr(md5(n), 0, 6)}"
    ], p.name)])
    error_message = "extra_node_pools names may not equal the temporary pool name AKS uses to rebuild another pool on a new VM size: the default pool's (defaulc21f96), the Spot pool's (spotb2e189), pool1..pool100's (pool15934c3 for pool1), or another named pool's (up to six characters of its name plus six hex characters of its md5). Rebuilding that pool would delete the pool that carries the name. Choose another name."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", p.instance_type)) && contains(["amd64", "arm64"], p.arch) && contains(["on-demand", "spot"], p.capacity_type)
    ])
    error_message = "extra_node_pools instance_type must be a cloud instance type such as \"m7g.large\", \"e2-standard-4\", \"Standard_D4s_v5\" or \"cx32\" (letters, digits, '.', '_' and '-', up to 64); arch must be \"amd64\" or \"arm64\"; capacity_type must be \"on-demand\" or \"spot\"."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      floor(p.min_size) == p.min_size && floor(p.max_size) == p.max_size && p.min_size >= 0 && p.max_size >= 1 && p.max_size <= 100 && p.min_size <= p.max_size &&
      (p.desired_size == null ? true : floor(p.desired_size) == p.desired_size && p.desired_size >= p.min_size && p.desired_size <= p.max_size)
    ])
    error_message = "extra_node_pools sizes must be whole numbers with 0 <= min_size <= desired_size <= max_size and 1 <= max_size <= 100. desired_size may be left out, and then equals min_size."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools : length(p.labels) <= 25]) && alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ]]))
    error_message = "extra_node_pools labels may hold at most 25 labels per pool. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ]]))
    error_message = "extra_node_pools labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia labels every pool alethia.io/pool=<name> itself."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      length(p.taints) <= 25 && alltrue([for t in p.taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in p.taints : "${t.key}:${t.effect}"])) == length(p.taints)
    ])
    error_message = "extra_node_pools taints may hold at most 25 taints per pool, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once in a pool."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ]]))
    error_message = "extra_node_pools taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ]]))
    error_message = "extra_node_pools taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia taints every arm64 pool alethia.io/arch=arm64:NoSchedule itself."
  }
}
