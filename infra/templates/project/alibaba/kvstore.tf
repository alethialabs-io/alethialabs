# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "kvstore" {
  source = "./modules/kvstore"
  count  = var.create_kvstore ? 1 : 0

  depends_on = [module.network]

  instance_name  = local.kvstore_name
  instance_class = var.kvstore_instance_class
  engine_version = var.kvstore_engine_version

  vswitch_id        = local.vswitch_ids[0]
  zone_id           = local.zone_ids[0]
  secondary_zone_id = length(local.zone_ids) > 1 ? local.zone_ids[1] : ""
  multi_az          = var.kvstore_multi_az
  shard_count       = var.kvstore_shard_count

  # #2149. `security_ips` REPLACES the instance whitelist rather than adding to it, so when the user
  # asks for extra ranges the VPC's own CIDR rides along — AllowedCidrBlocks are EXTRA ranges ("the
  # cluster always can"), the same union aws/locals.tf builds into redis_allowed_cidr_blocks. Empty
  # stays empty: the module then renders no argument and an existing cache keeps its whitelist.
  security_ips = length(var.kvstore_security_ips) > 0 ? concat(var.kvstore_security_ips, [var.network_cidr]) : []

  tags = local.common_tags
}
