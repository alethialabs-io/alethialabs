#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID to deploy resources into"

  # FAIL CLOSED — same shape as aws_account_id in the aws template. This flows from the same
  # CloudAccountID field (packages/core/cloud/gcp_provider.go emits it as `project_id`) and the
  # runner resolves it the same way, so the same empty-value hole exists here. An empty project
  # id fails EVERY google_* resource rather than one, so it must be caught at plan time.
  # Google's rule: 6-30 chars, lowercase letter first, letters/digits/hyphens, no trailing hyphen.
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id (6-30 chars, lowercase letter first, letters/digits/hyphens, no trailing hyphen). It is empty or malformed — the runner resolves it from the connector's CloudIdentity, or for an ambient-credential runner from $GOOGLE_PROJECT."
  }
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

# Per-cloud classification labels emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia_project-id` /
# `alethia_environment-id` sweep handles (GCP label charset — lowercase, `_`-namespaced). Merged
# into local.gcp_default_labels so it lands on every taggable resource; the platform base labels
# always WIN a key collision (they sit on the merge RHS).
variable "classification_tags" {
  type        = map(string)
  description = "Classification + sweep-handle labels to stamp on every taggable resource. Platform base labels override on conflict."
  default     = {}
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

  validation {
    condition     = can(cidrhost(var.network_cidr, 0))
    error_message = "network_cidr must be a valid IPv4 CIDR, e.g. 10.0.0.0/16."
  }
}

variable "network_id" {
  type        = string
  default     = ""
  description = "Self-link of an existing VPC network (used when provision_network = false)"
}

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "Self-links of user-selected existing subnetworks for a brownfield network (provision_network = false, #1352). Empty = auto-discover the subnetwork in var.region. Only the first entry is used (GKE attaches to one subnetwork). Replaces the former write-only subnetwork_id variable."
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

  validation {
    condition     = can(cidrhost(var.pods_cidr_range, 0))
    error_message = "pods_cidr_range must be a valid IPv4 CIDR."
  }
}

variable "services_cidr_range" {
  type        = string
  default     = "10.2.0.0/20"
  description = "Secondary CIDR range for GKE services"

  validation {
    condition     = can(cidrhost(var.services_cidr_range, 0))
    error_message = "services_cidr_range must be a valid IPv4 CIDR."
  }
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
  type = string
  # 1.31 is GONE from GKE — a fresh apply fails with `No valid versions with the prefix "1.31"
  # found` (verified on real GKE: only 1.33/1.34/1.35/1.36 remain). Pin a currently-served minor.
  # NOTE: the managed path sets this from the catalog SSOT (catalog.json); this default is the
  # BYO-IaC fallback only. Keep both on the same standard minor.
  default     = "1.35"
  description = "Desired Kubernetes master version (must be a minor GKE still serves)"
}

variable "gke_instance_types" {
  type        = list(string)
  default     = ["e2-standard-4"]
  description = "Machine types for the GKE node pool"

  validation {
    condition     = length(var.gke_instance_types) > 0
    error_message = "gke_instance_types must list at least one machine type."
  }
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

  validation {
    condition     = var.gke_node_max_size >= var.gke_node_min_size
    error_message = "gke_node_max_size must be >= gke_node_min_size."
  }
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

  validation {
    condition     = var.gke_disk_size_gb >= 20
    error_message = "gke_disk_size_gb must be at least 20 GB."
  }
}

variable "gke_disk_type" {
  type        = string
  default     = "pd-standard"
  description = "Type of the disk attached to each node (pd-standard, pd-ssd, pd-balanced)"

  validation {
    condition     = contains(["pd-standard", "pd-ssd", "pd-balanced"], var.gke_disk_type)
    error_message = "gke_disk_type must be one of pd-standard, pd-ssd, pd-balanced."
  }
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
  type = string
  # BARE version only. The cloud-sql module composes "${engine_map[engine]}_${engine_version}",
  # so "POSTGRES_16" here produced the invalid database_version "POSTGRES_POSTGRES_16" and Cloud
  # SQL could never be created. (Matches the Azure template, whose default is likewise "16".)
  default     = "16"
  description = "Database engine version number, e.g. \"16\" for POSTGRES_16 (engine is set separately)"
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
      # Ordered delivery. Pub/Sub orders per orderingKey and only on the SUBSCRIPTION side, so a
      # canvas queue carries its switch here rather than on the topic. Changing it FORCES
      # REPLACEMENT of the subscription, dropping its unacknowledged backlog.
      enable_message_ordering = optional(bool, false)
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

variable "firestore_point_in_time_recovery" {
  type        = bool
  default     = false
  description = <<-EOT
    Whether to enable point-in-time recovery on the Firestore database.

    Aggregated with ANY across the project's NoSQL tables, because PITR is a property of the
    DATABASE and GCP allows exactly one Firestore database per project — what the canvas calls a
    "table" is a collection inside that single database. One table asking for point-in-time
    recovery therefore turns it on for all of them.

    When true the database keeps 1-minute snapshots for 7 days; when false, reads reach back one
    hour only. False is also Firestore's own default, so leaving this off leaves an existing
    database exactly as it is. The argument is not force-new: toggling it is an in-place PATCH.
  EOT
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
  description = "Action the Cloud Armor catch-all rule applies to every request none of cloud_armor_rules matched. Reachable through the DNS provider_config passthrough."

  # Validated, not free text. The value is now READ (it reaches modules/cloud-armor.default_action —
  # until #1826 it reached nothing at all), and the module binds to the platform ingress, so a typo
  # would either fail mid-apply at the GCP API or, worse, be accepted as a different posture than the
  # operator asked for. Finite and known ⇒ an enumerated set.
  validation {
    condition     = contains(["allow", "deny(403)", "deny(404)", "deny(502)"], var.cloud_armor_default_action)
    error_message = "cloud_armor_default_action must be one of: allow, deny(403), deny(404), deny(502)."
  }
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
    name_suffix   = string
    location      = optional(string)
    storage_class = optional(string, "STANDARD")
    versioning    = optional(bool, false)
    force_destroy = optional(bool, false)
    # Uniform bucket-level access is NOT a knob, and this attribute is no longer `uniform_access`.
    # UBLA only disables per-object ACLs — it says nothing about public reads — and Cloud Storage
    # REFUSES to turn it back off more than 90 days after it was enabled, so a user-facing switch
    # routed through it would eventually become an apply that can never succeed. UBLA is on for
    # every bucket, permanently; `public_access` drives `public_access_prevention` and the allUsers
    # IAM binding in modules/cloud-storage, which is what actually decides public readability.
    public_access = optional(bool, false)
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
    format         = optional(string, "DOCKER")
    description    = optional(string, "")
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

variable "cloud_sql_edition" {
  type        = string
  default     = "ENTERPRISE"
  description = "Cloud SQL edition. ENTERPRISE supports the standard tiers (db-f1-micro etc.); ENTERPRISE_PLUS requires db-perf-optimized-N-* tiers. Left unset, the API now defaults to ENTERPRISE_PLUS and rejects the default tier."
}

# ── external-secrets identity adoption ─────────────────────────────────────────
variable "external_secrets_service_account_email" {
  description = <<-EOT
    OPTIONAL. Email of a PRE-EXISTING Google service account for the external-secrets operator to
    run as, instead of the per-deploy one this template creates.

    Why this exists: a cross-project Secret Manager grant in the TARGET project names this GSA by
    email, and GCP does not treat a same-named recreation as the same identity — destroying the SA
    rewrites the binding to `deleted:serviceAccount:...?uid=<old-uid>`, which the new SA does not
    inherit. GCP IAM also offers no principal-pattern condition, so a grant cannot be written
    against a per-run identity. Adopting a stable GSA lets the target-project grant be applied ONCE.

    Empty (the default) preserves the existing behavior exactly: the template creates and owns the
    GSA. When set, the account must already exist in var.project_id and the caller owns its
    lifecycle — this template will not create, modify or destroy it.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.external_secrets_service_account_email == "" || can(regex("^[^@]+@[^@]+\\.iam\\.gserviceaccount\\.com$", var.external_secrets_service_account_email))
    error_message = "external_secrets_service_account_email must be a full service-account email (name@project.iam.gserviceaccount.com), not a bare account id."
  }
}

variable "create_memorystore_valkey" {
  type        = bool
  description = "Provision Memorystore for Valkey instead of Redis. Mutually exclusive with create_memorystore — the chosen cache engine sets exactly one."
  default     = false
}

variable "memorystore_valkey_engine_version" {
  type        = string
  description = "Valkey engine enum (VALKEY_7_2, …)"
  default     = "VALKEY_7_2"
}

variable "memorystore_valkey_node_type" {
  type        = string
  description = "Per-shard machine size for the Valkey instance"
  default     = "SHARED_CORE_NANO"
}

variable "memorystore_valkey_shard_count" {
  type        = number
  description = "Number of Valkey shards (derived from the requested memory)"
  default     = 1
}

variable "memorystore_valkey_replica_count" {
  type        = number
  description = "Replica nodes per Valkey shard"
  default     = 0
}
