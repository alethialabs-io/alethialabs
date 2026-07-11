# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "rds" {
  source = "./modules/rds"
  count  = var.create_rds ? 1 : 0

  depends_on = [module.network]

  instance_name  = local.rds_name
  engine         = var.rds_engine
  engine_version = var.rds_engine_version
  instance_type  = var.rds_instance_type
  port           = var.rds_port

  backup_retention_days = var.rds_backup_retention_days

  vswitch_id = local.vswitch_ids[0]

  tags = local.common_tags
}
