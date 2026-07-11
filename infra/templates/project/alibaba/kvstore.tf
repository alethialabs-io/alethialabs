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

  tags = local.common_tags
}
