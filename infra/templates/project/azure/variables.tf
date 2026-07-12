#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID to deploy resources into"
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

#########################################################################
##                   Network Variables                                 ##
#########################################################################

variable "provision_vnet" {
  type        = bool
  default     = true
  description = "Whether to provision a new Virtual Network"
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
  default     = "1.33"
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
    name                       = string
    partition_key              = optional(string, "/id")
    billing_mode               = optional(string, "PAY_PER_REQUEST")
    analytical_storage_enabled = optional(bool, false)
  }))
  default     = []
  description = "List of Cosmos DB containers (collections) to create with partition keys"
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

variable "azure_managed_certificate" {
  type        = bool
  default     = false
  description = "Whether to provision an Azure-managed TLS certificate via App Service Managed Certificate"
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

variable "storage_containers" {
  type        = list(any)
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

#########################################################################
##                   Custom Terraform Variables                        ##
#########################################################################

variable "custom_iac_vars" {
  type        = any
  default     = {}
  description = "Object of custom values that can be used for extra terraform files outside of the template"
}
