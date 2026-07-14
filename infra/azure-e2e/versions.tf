# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"

  required_providers {
    # azurerm 4.x — several AKS/args were renamed vs 3.x; this stack only touches subscription
    # role assignments + a consumption budget + an action group, all stable across 4.x.
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # azuread 3.x — the Entra app / service principal / federated credential / admin group live
    # here. (3.x renamed `application_id` → `client_id` on azuread_service_principal + the
    # federated-credential resource; the config below uses the 3.x names.)
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }
}
