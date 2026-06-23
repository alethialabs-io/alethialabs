#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID to deploy resources into"
}

variable "region" {
  type        = string
  description = "GCP region to deploy to"
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
##                   Networking Variables                              ##
#########################################################################

variable "provision_network" {
  type        = bool
  default     = true
  description = "Whether to provision a new VPC network"
}

variable "network_cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "Primary CIDR range for the VPC subnet"
}

variable "network_id" {
  type        = string
  default     = ""
  description = "Self-link of an existing VPC network (used when provision_network = false)"
}

variable "subnetwork_id" {
  type        = string
  default     = ""
  description = "Self-link of an existing subnetwork (used when provision_network = false)"
}

variable "single_cloud_nat" {
  type        = bool
  default     = false
  description = "Whether to use a single Cloud NAT instead of one per zone. Suitable for dev/test environments"
}

variable "pods_cidr_range" {
  type        = string
  default     = "10.1.0.0/16"
  description = "Secondary CIDR range for GKE pods"
}

variable "services_cidr_range" {
  type        = string
  default     = "10.2.0.0/20"
  description = "Secondary CIDR range for GKE services"
}

#########################################################################
##                   GKE Variables                                     ##
#########################################################################

variable "provision_gke" {
  type        = bool
  default     = true
  description = "Whether to provision a GKE cluster"
}

variable "gke_cluster_version" {
  type        = string
  default     = "1.31"
  description = "Desired Kubernetes master version"
}

variable "gke_instance_types" {
  type        = list(string)
  default     = ["e2-standard-4"]
  description = "Machine types for the GKE node pool"
}

variable "gke_node_min_size" {
  type        = number
  default     = 1
  description = "Minimum number of nodes in the node pool"
}

variable "gke_node_max_size" {
  type        = number
  default     = 5
  description = "Maximum number of nodes in the node pool"
}

variable "gke_node_desired_size" {
  type        = number
  default     = 2
  description = "Initial/desired number of nodes in the node pool"
}

variable "gke_enable_autopilot" {
  type        = bool
  default     = false
  description = "Enable GKE Autopilot mode (ignores node pool configuration when true)"
}

variable "gke_disk_size_gb" {
  type        = number
  default     = 50
  description = "Size of the disk attached to each node (GB)"
}

variable "gke_disk_type" {
  type        = string
  default     = "pd-standard"
  description = "Type of the disk attached to each node (pd-standard, pd-ssd, pd-balanced)"
}

variable "gke_preemptible" {
  type        = bool
  default     = false
  description = "Whether to use preemptible VMs for the node pool"
}

variable "gke_spot" {
  type        = bool
  default     = true
  description = "Whether to use Spot VMs for the node pool"
}

variable "gke_master_authorized_cidr_blocks" {
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = [{
    cidr_block   = "0.0.0.0/0"
    display_name = "all"
  }]
  description = "CIDR blocks authorized to access the GKE master endpoint"
}

variable "gke_enable_private_nodes" {
  type        = bool
  default     = true
  description = "Whether nodes have only private IP addresses"
}

variable "gke_enable_private_endpoint" {
  type        = bool
  default     = false
  description = "Whether the master endpoint is accessible only from private IP addresses"
}

variable "gke_log_retention_days" {
  type        = number
  default     = 14
  description = "Cluster log retention in days"
}

#########################################################################
##                   Cloud SQL Variables                               ##
#########################################################################

variable "create_cloud_sql" {
  type        = bool
  default     = false
  description = "Whether to create a Cloud SQL instance"
}

variable "cloud_sql_engine" {
  type        = string
  default     = "POSTGRES"
  description = "Database engine type (POSTGRES or MYSQL)"
}

variable "cloud_sql_engine_version" {
  type        = string
  default     = "POSTGRES_16"
  description = "Database engine version"
}

variable "cloud_sql_tier" {
  type        = string
  default     = "db-f1-micro"
  description = "The machine type / tier for the Cloud SQL instance"
}

variable "cloud_sql_disk_size" {
  type        = number
  default     = 10
  description = "Storage size in GB for the Cloud SQL instance"
}

variable "cloud_sql_high_availability" {
  type        = bool
  default     = false
  description = "Whether to enable high availability (regional) for Cloud SQL"
}

variable "cloud_sql_backup_enabled" {
  type        = bool
  default     = true
  description = "Whether automated backups are enabled for Cloud SQL"
}

variable "cloud_sql_backup_retention_days" {
  type        = number
  default     = 7
  description = "Number of days to retain Cloud SQL backups"
}

variable "cloud_sql_iam_auth" {
  type        = bool
  default     = false
  description = "Whether to enable IAM authentication for Cloud SQL"
}

variable "cloud_sql_port" {
  type        = number
  default     = 5432
  description = "Port number for the Cloud SQL instance"
}

variable "cloud_sql_database_flags" {
  type = list(object({
    name  = string
    value = string
  }))
  default     = []
  description = "List of database flags to set on the Cloud SQL instance"
}

variable "cloud_sql_authorized_networks" {
  type = list(object({
    name  = string
    value = string
  }))
  default     = []
  description = "List of authorized networks that can connect to Cloud SQL"
}

variable "cloud_sql_default_username" {
  type        = string
  default     = "postgres"
  description = "Default database username"
}

#########################################################################
##                   Memorystore (Redis) Variables                     ##
#########################################################################

variable "create_memorystore" {
  type        = bool
  default     = false
  description = "Whether to create a Memorystore Redis instance"
}

variable "memorystore_tier" {
  type        = string
  default     = "BASIC"
  description = "Service tier for Memorystore (BASIC or STANDARD_HA)"
}

variable "memorystore_memory_size_gb" {
  type        = number
  default     = 1
  description = "Memory size in GB for the Memorystore instance"
}

variable "memorystore_redis_version" {
  type        = string
  default     = "REDIS_7_0"
  description = "Redis version for Memorystore"
}

variable "memorystore_auth_enabled" {
  type        = bool
  default     = false
  description = "Whether AUTH is enabled for Memorystore"
}

variable "memorystore_transit_encryption_mode" {
  type        = string
  default     = "DISABLED"
  description = "Transit encryption mode for Memorystore (DISABLED or SERVER_AUTHENTICATION)"
}

#########################################################################
##                   Pub/Sub Variables                                 ##
#########################################################################

variable "create_pubsub" {
  type        = bool
  default     = false
  description = "Whether to create Pub/Sub topics and subscriptions"
}

variable "pubsub_topics" {
  type = map(object({
    message_retention_duration = optional(string, "86400s")
    subscriptions = list(object({
      name                 = string
      ack_deadline_seconds = optional(number, 10)
    }))
  }))
  default     = {}
  description = "Map of Pub/Sub topics with their subscriptions"
}

#########################################################################
##                   Firestore Variables                               ##
#########################################################################

variable "create_firestore" {
  type        = bool
  default     = false
  description = "Whether to create a Firestore database"
}

variable "firestore_database_type" {
  type        = string
  default     = "FIRESTORE_NATIVE"
  description = "Firestore database type (FIRESTORE_NATIVE or DATASTORE_MODE)"
}

variable "firestore_location_id" {
  type        = string
  default     = ""
  description = "Location for Firestore database (defaults to var.region if empty)"
}

variable "firestore_delete_protection_state" {
  type        = string
  default     = "DELETE_PROTECTION_ENABLED"
  description = "Delete protection state for Firestore (DELETE_PROTECTION_ENABLED or DELETE_PROTECTION_DISABLED)"
}

#########################################################################
##                   Cloud DNS Variables                               ##
#########################################################################

variable "cloud_dns_enabled" {
  type        = bool
  default     = false
  description = "Whether to create Cloud DNS managed zone"
}

variable "cloud_dns_zone_name" {
  type        = string
  default     = ""
  description = "Name of the Cloud DNS managed zone"
}

variable "cloud_dns_domain" {
  type        = string
  default     = ""
  description = "DNS domain name for the managed zone (must end with a dot)"
}

variable "cloud_dns_managed_certificate" {
  type        = bool
  default     = false
  description = "Whether to create a Google-managed SSL certificate for the domain"
}

#########################################################################
##                   Cloud Armor Variables                             ##
#########################################################################

variable "cloud_armor_enabled" {
  type        = bool
  default     = false
  description = "Whether to create Cloud Armor security policies"
}

variable "cloud_armor_rules" {
  type = list(object({
    action      = string
    priority    = number
    description = string
    expression  = string
  }))
  default     = []
  description = "List of Cloud Armor security policy rules"
}

variable "cloud_armor_default_action" {
  type        = string
  default     = "allow"
  description = "Default action for Cloud Armor (allow or deny(403))"
}

#########################################################################
##                   Cloud Storage Variables                           ##
#########################################################################

variable "create_cloud_storage" {
  type        = bool
  default     = false
  description = "Whether to create Cloud Storage buckets"
}

variable "cloud_storage_buckets" {
  type = list(object({
    name_suffix       = string
    location          = optional(string)
    storage_class     = optional(string, "STANDARD")
    versioning        = optional(bool, false)
    force_destroy     = optional(bool, false)
    uniform_access    = optional(bool, true)
    lifecycle_rules = optional(list(object({
      action_type          = string
      action_storage_class = optional(string)
      condition_age        = optional(number)
    })), [])
    cors_origins = optional(list(string), [])
    cors_methods = optional(list(string), [])
  }))
  default     = []
  description = "List of Cloud Storage buckets to create"
}

#########################################################################
##                   Artifact Registry Variables                       ##
#########################################################################

variable "provision_artifact_registry" {
  type        = bool
  default     = false
  description = "Whether to provision Artifact Registry repositories"
}

variable "artifact_registry_repos" {
  type = map(object({
    format        = optional(string, "DOCKER")
    description   = optional(string, "")
    immutable_tags = optional(bool, false)
  }))
  default     = {}
  description = "Map of Artifact Registry repositories to create"
}

#########################################################################
##                   Secret Manager Variables                          ##
#########################################################################

variable "custom_secrets" {
  type = list(object({
    name          = string
    generate      = bool
    length        = optional(number, 32)
    special_chars = optional(bool, true)
  }))
  default     = []
  description = "List of secrets to create in Secret Manager"
}

variable "custom_secret_keepers" {
  type        = map(map(string))
  default     = {}
  description = "Map of keepers for the secrets"
}

#########################################################################
##                   Custom Terraform Variables                        ##
#########################################################################

variable "custom_iac_vars" {
  type        = any
  default     = {}
  description = "Object of custom values that can be used for extra terraform files outside of the template"
}
