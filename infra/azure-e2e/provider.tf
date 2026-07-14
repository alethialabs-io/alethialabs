# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The maintainer applies this bootstrap with an admin identity (it creates an Entra app + role
# assignments), so both providers authenticate from that ambient identity (az login / ARM_* env) —
# no static secrets in the config or state.

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azuread" {}
