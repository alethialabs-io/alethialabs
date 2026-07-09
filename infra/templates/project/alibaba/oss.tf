# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "oss" {
  source = "./modules/oss"
  count  = var.create_oss ? 1 : 0

  buckets = var.oss_buckets

  tags = local.common_tags
}
