# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Subscription B — where the Key Vault and the canary live. The default provider, because almost
# everything in this stack is B's.
provider "azurerm" {
  subscription_id = var.target_subscription_id
  features {
    key_vault {
      # The vault is a test fixture with no purge protection (main.tf), so a destroy should free the
      # globally-unique name instead of parking it soft-deleted for the retention window.
      purge_soft_delete_on_destroy = true
    }
  }
}

# Subscription A — where the e2e cluster runs. Used for exactly one thing: the STANDING
# external-secrets identity the cluster adopts (main.tf). Same tenant, same credentials.
provider "azurerm" {
  alias           = "cluster"
  subscription_id = var.cluster_subscription_id
  features {}
}
