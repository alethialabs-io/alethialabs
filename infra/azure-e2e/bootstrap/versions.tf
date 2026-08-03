# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"

  required_providers {
    # Same 4.x pin as the parent stack so both are applied against one provider generation.
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# The maintainer applies this with an admin identity (az login / ARM_* env) — the same identity that
# applies the parent stack. `storage_use_azuread` makes the provider reach the blob data plane with
# that Entra identity instead of a storage account key, which is what lets the account below be
# created with shared-key auth switched off entirely.
provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}
