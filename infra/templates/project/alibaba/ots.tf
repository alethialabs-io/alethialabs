# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "ots" {
  source = "./modules/ots"
  count  = var.create_ots ? 1 : 0

  instance_name = local.ots_name
  tables        = var.ots_tables

  tags = local.common_tags
}
