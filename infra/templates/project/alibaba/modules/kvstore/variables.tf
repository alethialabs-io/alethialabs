# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the KVStore (Redis) instance"
}

variable "instance_class" {
  type        = string
  description = "Instance class for the KVStore instance"
}

variable "engine_version" {
  type        = string
  description = "Redis engine version"
}

variable "vswitch_id" {
  type        = string
  description = "Vswitch id the instance is placed in"
}

variable "zone_id" {
  type        = string
  description = "Primary availability zone id"
}

variable "secondary_zone_id" {
  type        = string
  default     = ""
  description = "Secondary availability zone id (for multi-AZ deployments)"
}

variable "multi_az" {
  type        = bool
  default     = false
  description = "Whether to enable a multi-availability-zone deployment"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the instance"
}

# #1996. Cluster-mode shards — the axis a "node count" means on ApsaraDB for Redis. Verified as a
# real argument on alicloud_kvstore_instance rather than assumed to be part of the SKU. 0 (the
# default) leaves the instance class's own topology untouched.
variable "shard_count" {
  type        = number
  default     = 0
  description = "Number of cluster-mode shards. 0 (the default) leaves the instance class's own topology alone."
}
