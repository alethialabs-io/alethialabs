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

#########################################################################
##                   DNS (AliDNS) / WAF Variables                      ##
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

variable "application_waf_enabled" {
  type        = bool
  default     = false
  description = "Whether to provision an Application (Web Application Firewall) domain protection"
}

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
  description = "List of OSS buckets to create"
}

#########################################################################
##                   Secrets (KMS) Variables                           ##
#########################################################################

variable "custom_secrets" {
  type        = list(any)
  default     = []
  description = "List of secrets to create in KMS Secrets Manager"
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
