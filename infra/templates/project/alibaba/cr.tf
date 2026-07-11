# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "cr" {
  source = "./modules/cr"
  count  = var.provision_cr && var.registry_provider == "native" ? 1 : 0

  instance_name  = local.cr_name
  namespace_name = var.project_name
}
