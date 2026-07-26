variable "project_id" {
  type        = string
  description = "GCP project id"
}

variable "region" {
  type        = string
  description = "Region the instance is created in"
}

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product, used in the naming convention"
}

variable "engine_version" {
  type        = string
  description = "Valkey engine version enum (e.g. VALKEY_7_2)"
  default     = "VALKEY_7_2"

  validation {
    condition     = can(regex("^VALKEY_[0-9]+_[0-9]+$", var.engine_version))
    error_message = "engine_version must be a Valkey enum token such as VALKEY_7_2 — not a bare version."
  }
}

variable "node_type" {
  type        = string
  description = "Per-shard machine size (SHARED_CORE_NANO, HIGHMEM_MEDIUM, STANDARD_SMALL, …)"
  default     = "SHARED_CORE_NANO"
}

variable "shard_count" {
  type        = number
  description = "Number of shards. Derived from the requested memory by the caller; never below 1."
  default     = 1

  validation {
    condition     = var.shard_count >= 1
    error_message = "shard_count must be at least 1 — a zero-shard instance stores nothing."
  }
}

variable "replica_count" {
  type        = number
  description = "Replica nodes per shard (0 = no replicas)"
  default     = 0
}

variable "network_self_link" {
  type        = string
  description = "Self link of the VPC the instance attaches to via PSC auto-connection"
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to the instance"
  default     = {}
}
