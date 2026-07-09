# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "waf" {
  source = "./modules/waf"
  count  = var.application_waf_enabled ? 1 : 0

  domain = var.alidns_domain

  tags = local.common_tags
}
