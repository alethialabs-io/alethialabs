# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Azure-native remote state in the SAME storage account as infra/azure-e2e (created by
# infra/azure-e2e/bootstrap), under its own key. Partial config: names come from backend.hcl.
terraform {
  backend "azurerm" {}
}
