# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "project_name" {
  type        = string
  description = "Name of the project / client / product, used in the naming convention"
}

# Per-cloud classification tags emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia:project-id` /
# `alethia:environment-id` sweep handles (colon-namespaced keys). Merged into local.common_tags so
# it lands on every taggable resource; the platform base tags always WIN a key collision (they sit
# on the merge RHS).
variable "classification_tags" {
  type        = map(string)
  description = "Classification + sweep-handle tags to stamp on every taggable resource. Platform base tags override on conflict."
  default     = {}
}

variable "region" {
  type        = string
  description = "Alibaba Cloud region to deploy resources into (e.g. cn-hangzhou, ap-southeast-1)"
}

variable "environment" {
  type        = string
  description = "Environment in which the infrastructure is deployed (e.g. dev, staging, production)"
}

# DOCUMENTED EXCLUSION from the fail-closed account-id guard that aws_account_id (aws),
# project_id (gcp) and subscription_id (azure) now carry. Those three are interpolated into
# account-scoped ARNs/resource ids, so an empty value produces a confusing mid-apply failure and
# has to be rejected at plan time. This one is INFORMATIONAL — it is not interpolated into any
# resource, it is declared optional with an empty default, and an empty value changes nothing.
# Adding a validation here would break every existing caller to guard a value nothing reads.
# hetzner is excluded for a different reason: it is account-less at the tofu layer entirely.
# If this ever starts feeding a real resource id, it needs the guard.
variable "alibaba_account" {
  type        = string
  default     = ""
  description = "Alibaba Cloud account (UID) the resources belong to. Informational only"
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
  description = "Primary CIDR range for the VPC"

  validation {
    condition     = can(cidrhost(var.network_cidr, 0))
    error_message = "network_cidr must be a valid IPv4 CIDR, e.g. 10.0.0.0/16."
  }
}

variable "single_cloud_nat" {
  type        = bool
  default     = true
  description = "Whether to provision a single NAT gateway for outbound access (suitable for dev/test)"
}

variable "network_id" {
  type        = string
  default     = ""
  description = "Id of an existing VPC to attach to (used when provision_network = false)"
}

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "User-selected vSwitch ids within the existing VPC (brownfield, provision_network = false, #1352). Empty = auto-discover the VPC's vSwitches (unordered). ACK spans all entries; RDS/KVStore use the first, so ordering is honored."
}

#########################################################################
##                   ACK (Kubernetes) Variables                        ##
#########################################################################

variable "provision_ack" {
  type        = bool
  default     = true
  description = "Whether to provision an ACK managed Kubernetes cluster"
}

variable "ack_cluster_version" {
  type = string
  # NOTE: the managed path sets this from the catalog SSOT (catalog.json); this default is the
  # BYO-IaC fallback only. Keep both on the same standard minor.
  default     = "1.35"
  description = "Kubernetes version for the ACK cluster"
}

variable "ack_instance_types" {
  type        = list(string)
  default     = ["ecs.g6.large"]
  description = "ECS instance types for the ACK node pool"

  validation {
    condition     = length(var.ack_instance_types) > 0
    error_message = "ack_instance_types must list at least one instance type."
  }
}

variable "ack_node_min_size" {
  type        = number
  default     = 2
  description = "Minimum number of nodes in the ACK node pool"
}

variable "ack_node_max_size" {
  type        = number
  default     = 5
  description = "Maximum number of nodes in the ACK node pool"

  validation {
    condition     = var.ack_node_max_size >= var.ack_node_min_size
    error_message = "ack_node_max_size must be >= ack_node_min_size."
  }
}

variable "ack_node_desired_size" {
  type        = number
  default     = 2
  description = "Initial/desired number of nodes in the ACK node pool"
}

variable "ack_disk_size_gb" {
  type        = number
  default     = 40
  description = "System disk size (GB) for each ACK node"

  validation {
    condition     = var.ack_disk_size_gb >= 20
    error_message = "ack_disk_size_gb must be at least 20 GB."
  }
}

# ── Node system disk (aws parity: eks_volume_type / eks_volume_iops) ─────────────────────────────
# `cloud_essd` is not a chosen default — it is the value modules/cluster/main.tf hardcoded until
# this change, so every project that exists plans unchanged.
variable "ack_disk_category" {
  type        = string
  default     = "cloud_essd"
  description = "System disk category for each ACK node. cloud_essd takes a performance level (ack_disk_performance_level); cloud_auto takes provisioned IOPS (ack_disk_provisioned_iops); the others take neither."

  validation {
    condition     = contains(["cloud_efficiency", "cloud_ssd", "cloud_essd", "cloud_auto", "cloud_essd_entry"], var.ack_disk_category)
    error_message = "ack_disk_category must be one of cloud_efficiency, cloud_ssd, cloud_essd, cloud_auto, cloud_essd_entry."
  }
}

# ⚠️ Alibaba does NOT have aws's single `iops` number. Disk performance is TWO mutually exclusive
# arguments, each coupled to a different disk category, and the API silently ignores the one that
# does not belong to the category in play. checks_cluster.tf blocks that pairing at plan time — a
# knob that is reachable and quietly does nothing is worse than a knob that is missing.
variable "ack_disk_performance_level" {
  type        = number
  default     = null
  description = "ESSD performance level for each ACK node's system disk (0-3, rendered as PL0-PL3). Requires ack_disk_category = cloud_essd. Null (the default) leaves Alibaba's own default in place."

  # `coalesce` to a valid member rather than `var.x == null || contains(…)`. OpenTofu does NOT
  # short-circuit `||` inside a validation condition, so `contains(list, null)` is evaluated and
  # raises "Invalid function argument" — the guard fails on the DEFAULT, the one input it must accept.
  validation {
    condition     = contains([0, 1, 2, 3], coalesce(var.ack_disk_performance_level, 0))
    error_message = "ack_disk_performance_level must be 0, 1, 2 or 3 (PL0-PL3), or null."
  }
}

variable "ack_disk_provisioned_iops" {
  type        = number
  default     = null
  description = "Provisioned IOPS for each ACK node's system disk. Requires ack_disk_category = cloud_auto. Null (the default) leaves the disk on its category's baseline performance."

  # Same non-short-circuit rule as above: `null > 0` is an "Operation failed" error, not a false, so
  # the null default must be replaced before the comparison rather than guarded in front of it.
  validation {
    condition     = coalesce(var.ack_disk_provisioned_iops, 1) > 0
    error_message = "ack_disk_provisioned_iops must be a positive number, or null."
  }
}

# ── Interruptible capacity (aws parity: eks_ng_capacity_type) ────────────────────────────────────
# "NoSpot" is the ACK API's own name for on-demand and is what the node pool provisions today with
# the argument unset, so the default is behavior-preserving.
variable "ack_node_capacity_type" {
  type        = string
  default     = "NoSpot"
  description = "Bidding strategy for the ACK node pool. NoSpot = on-demand (the default). SpotWithPriceLimit requires ack_spot_price_limit; SpotAsPriceGo bids the market rate."

  validation {
    condition     = contains(["NoSpot", "SpotWithPriceLimit", "SpotAsPriceGo"], var.ack_node_capacity_type)
    error_message = "ack_node_capacity_type must be one of NoSpot, SpotWithPriceLimit, SpotAsPriceGo."
  }
}

variable "ack_spot_price_limit" {
  type = list(object({
    instance_type = string
    price_limit   = string
  }))
  default     = []
  description = "Per-instance-type hourly bid ceilings, required when ack_node_capacity_type = SpotWithPriceLimit and meaningless otherwise. price_limit is a decimal string, e.g. \"0.35\"."
}

#########################################################################
##                     DNS (AliDNS) Variables                          ##
#########################################################################

variable "alidns_enabled" {
  type        = bool
  default     = false
  description = "Whether to create an AliDNS domain"
}

variable "alidns_domain" {
  type        = string
  default     = ""
  description = "Domain name to manage in AliDNS"
}

variable "alidns_zone_name" {
  type        = string
  default     = ""
  description = "Logical name/group for the AliDNS domain (defaults to a derived name if empty)"
}

variable "alidns_managed_certificate" {
  type        = bool
  default     = false
  description = "Whether to request a managed certificate for the AliDNS domain"
}

# NO `application_waf_enabled` HERE, unlike aws/azure/gcp — the WAF offer is withdrawn on this
# cloud (#1841), and re-adding the variable is how it would quietly come back. `alicloud_wafv3_instance`
# takes no arguments at all, so nothing distinguishes two instances, and its create/delete are
# CreatePostpaidInstance/ReleaseInstance: the purchase is ACCOUNT-scoped, and a per-project state
# model cannot own it safely — destroying one project would release the account's firewall out from
# under every other project sharing it. The decision is recorded in infra/offer-exclusions.yaml and
# pinned by TestAlibabaProviderTfvars_CarriesNoWafSwitch, so nothing can carry a switch to a variable
# that is deliberately absent.

#########################################################################
##                   MNS (Message Service) Variables                   ##
#########################################################################

variable "create_mns" {
  type        = bool
  default     = false
  description = "Whether to create MNS queues and topics"
}

variable "mns_queues" {
  type        = map(any)
  default     = {}
  description = "Map of MNS queues to create, keyed by queue name"
}

variable "mns_topics" {
  type        = map(any)
  default     = {}
  description = "Map of MNS topics to create, keyed by topic name"
}

#########################################################################
##                   Redis (KVStore) Variables                         ##
#########################################################################

variable "create_kvstore" {
  type        = bool
  default     = false
  description = "Whether to create a KVStore (Redis) instance"
}

variable "kvstore_engine_version" {
  type        = string
  default     = "7.0"
  description = "Redis engine version for the KVStore instance"
}

variable "kvstore_instance_class" {
  type        = string
  default     = "redis.master.small.default"
  description = "Instance class for the KVStore (Redis) instance"
}

variable "kvstore_multi_az" {
  type        = bool
  default     = false
  description = "Whether to enable multi-availability-zone deployment for KVStore"
}

#########################################################################
##                   Tablestore (OTS) Variables                        ##
#########################################################################

variable "create_ots" {
  type        = bool
  default     = false
  description = "Whether to create a Tablestore (OTS) instance and tables"
}

variable "ots_tables" {
  type        = list(any)
  default     = []
  description = "List of Tablestore tables to create"
}

#########################################################################
##                   Container Registry (CR) Variables                 ##
#########################################################################

variable "provision_cr" {
  type        = bool
  default     = false
  description = "Whether to provision a Container Registry (CR) instance and namespace"
}

# TYPED on purpose — see the note on the module's own `repos`. Keyed by the registry component's
# name. `immutable_tags` is the canvas's "Immutable tags" switch, defaulting to the setting the
# repository would have been created with anyway, so an emitter that omits it downgrades nothing.
variable "cr_repos" {
  type = map(object({
    summary        = optional(string, "")
    immutable_tags = optional(bool, true)
  }))
  default     = {}
  description = "Container Registry repositories to create, keyed by the registry component's name"
}

#########################################################################
##                   OSS (Object Storage) Variables                    ##
#########################################################################

variable "create_oss" {
  type        = bool
  default     = false
  description = "Whether to create OSS buckets"
}

variable "oss_buckets" {
  type        = list(any)
  default     = []
  description = "List of OSS buckets to create. Entry shape is declared by modules/oss's typed `buckets` variable."

  # FAIL CLOSED at plan time. PutBucketEncryption documents exactly AES256 and KMS and answers
  # anything else with InvalidEncryptionAlgorithmError — but the Terraform provider's own ValidateFunc
  # also accepts "SM4", so a provider-valid SM4 (reachable through provider_config passthrough) would
  # plan clean and fail at apply. Refusing it here turns an apply-time 400 into a plan-time error.
  #
  # This lives on the root rather than on modules/oss's typed variable so that `tofu test` can prove
  # it: expect_failures only addresses root-module checkables, and an unprovable guard is how a
  # non-guard ships. `try` because this variable is list(any) and the key is optional.
  validation {
    condition     = alltrue([for b in var.oss_buckets : contains(["None", "AES256", "KMS"], try(b.sse_algorithm, "None"))])
    error_message = "sse_algorithm must be one of None, AES256 or KMS. OSS PutBucketEncryption rejects every other value, including the SM4 the Terraform provider will let through."
  }
}

#########################################################################
##                   Secrets (KMS) Variables                           ##
#########################################################################

variable "custom_secrets" {
  type        = list(any)
  default     = []
  description = "List of secrets to create in KMS Secrets Manager"
}

# Parity with aws (custom_secrets.tf), gcp and azure: the ONLY lever random_password offers for
# re-generating a value it has already produced. Without it an Alibaba project's generated secrets
# are immutable for the life of the KMS secret — rotation would mean destroying it.
variable "custom_secret_keepers" {
  type        = map(map(string))
  default     = {}
  description = "Per-secret rotation keepers, keyed by secret name. Changing any value under a name re-generates that secret's password; a name absent from the map keeps its value forever. Empty (the default) is behavior-preserving."
}

#########################################################################
##                   RDS Variables                                     ##
#########################################################################

variable "create_rds" {
  type        = bool
  default     = false
  description = "Whether to create an ApsaraDB RDS instance"
}

variable "rds_engine" {
  type        = string
  default     = "PostgreSQL"
  description = "RDS database engine (PostgreSQL or MySQL)"
}

variable "rds_engine_version" {
  type        = string
  default     = "16.0"
  description = "RDS database engine version"
}

variable "rds_instance_type" {
  type        = string
  default     = "pg.n2.small.2c"
  description = "RDS instance class/type"
}

variable "rds_port" {
  type        = number
  default     = 5432
  description = "Port the RDS instance listens on"
}

variable "rds_backup_retention_days" {
  type        = number
  default     = 7
  description = "Number of days to retain automated RDS backups"
}

variable "vswitch_count" {
  type        = number
  default     = 3
  description = "STATIC number of vswitches the network module creates (plan-known under the keyless RAM-OIDC provider — #621); zone assignment wraps over the discovered zones via element()."
}

# #1987. ADDITIVE, never restrictive: modules/network creates a security group for these ranges and
# attaches it to the ACK node pool, alongside the group ACK manages itself. Empty (the default)
# creates nothing at all, so the plan is byte-identical and the external runner keeps its access.
variable "network_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "Extra source CIDRs permitted inbound to this VPC's cluster nodes. Empty (the default) adds nothing."

  validation {
    # alltrue([]) is true, so the empty default passes without a special case.
    condition     = alltrue([for c in var.network_allowed_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "network_allowed_cidr_blocks must all be valid CIDRs (e.g. 10.1.0.0/16)."
  }
}

# #1996. See modules/kvstore for why this is shards rather than replicas.
variable "kvstore_shard_count" {
  type        = number
  default     = 0
  description = "Number of cluster-mode shards for the Redis instance. 0 (the default) leaves the instance class's own topology alone."
}

# #1996. Alibaba is NOT part of the azure/gcp serverless ceiling: alicloud_db_instance accepts a
# serverless_config block, so the range is expressible. Both default to 0, which renders no block at
# all — a provisioned (non-serverless) instance is unaffected.
variable "rds_serverless_min_capacity" {
  type        = number
  default     = 0
  description = "Minimum serverless capacity (RCUs). 0 (the default) provisions a fixed-size instance with no serverless range."
}

variable "rds_serverless_max_capacity" {
  type        = number
  default     = 0
  description = "Maximum serverless capacity (RCUs). 0 (the default) provisions a fixed-size instance with no serverless range."
}

# ── Secrets envelope encryption for ACK (#2004) ─────────────────────────────────────────────────
# ON BY DEFAULT, matching what AWS has always done silently (the upstream EKS module defaults
# create_kms_key = true and encrypts `secrets`).
variable "ack_secrets_encryption_enabled" {
  type        = bool
  default     = true
  description = "Envelope-encrypt Kubernetes Secrets in etcd under a customer-managed KMS key. On by default (AWS parity)."
}
