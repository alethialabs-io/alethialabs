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
  type        = list(string)
  default     = ["Standard_D4s_v5"]
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
  description = "Hourly ceiling (USD) for a Spot node. -1 (the default) means pay up to the on-demand price and never get evicted on price alone — only on capacity."

  validation {
    condition     = var.aks_spot_max_price == -1 || var.aks_spot_max_price > 0
    error_message = "aks_spot_max_price must be -1 (pay up to on-demand) or a positive hourly price."
  }
}

variable "aks_spot_eviction_policy" {
  type        = string
  default     = "Delete"
  description = "What Azure does to a reclaimed Spot node: \"Delete\" (the default — the node is removed and the autoscaler replaces it) or \"Deallocate\" (the node is stopped but its quota is held)."

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

variable "azure_cache_family" {
  type        = string
  default     = "C"
  description = "SKU family for Azure Cache for Redis (C for Basic/Standard, P for Premium)"
}

variable "azure_cache_capacity" {
  type        = number
  default     = 0
  description = "Size of the Azure Cache for Redis instance (0-6 for C family, 1-5 for P family)"
}

variable "azure_cache_redis_version" {
  type        = string
  default     = "6"
  description = "Redis version for Azure Cache"
}

variable "azure_cache_multi_az" {
  type        = bool
  default     = false
  description = "Whether to enable zone redundancy for Azure Cache for Redis (requires Premium SKU)"
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
    billing_mode  = optional(string, "PAY_PER_REQUEST")
    # Point-in-time restore. Offered per table by the canvas, but Cosmos buys it per ACCOUNT (the
    # `backup` block below), so any container asking for it puts the whole account in continuous
    # backup mode — see `local.cosmos_backup_type` in cosmos-db.tf.
    point_in_time_recovery = optional(bool, false)
    # Synapse Link analytical (column) storage. A SEPARATE, separately-billed feature that is not a
    # backup: the canvas offers no switch for it, and nothing derives it from point_in_time_recovery
    # any more (#1838). Kept accepted so a tenant driving the tfvars directly can still ask for it.
    analytical_storage_enabled = optional(bool, false)
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
  }))
  default     = []
  description = "List of storage containers to create in the Storage Account"
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
