# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Azure-native remote state (a storage-account container in the same subscription). The admin
# identity that applies this bootstrap authenticates the backend natively — no static state keys.
# Configure with `tofu init -backend-config=backend.hcl`. For a first local apply you may instead
# `tofu init -backend=false` and keep state local (a bootstrap that creates only IAM-ish objects).
terraform {
  backend "azurerm" {}
}
