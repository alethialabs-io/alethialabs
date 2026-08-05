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

  serverless_min_capacity = var.rds_serverless_min_capacity
  serverless_max_capacity = var.rds_serverless_max_capacity

  vswitch_id = local.vswitch_ids[0]

  tags = local.common_tags
}
