# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Azure-native remote state (a storage-account container in the same subscription) — the Azure
# analogue of infra/aws-oidc's S3 backend. The admin identity that applies this bootstrap
# authenticates the backend natively (az login / ARM_* env), so there are no static state keys.
#
# Partial config on purpose: the account and container are supplied at init time rather than
# hardcoded.
#   tofu init -backend-config=backend.hcl
#
# The storage account itself comes from infra/azure-e2e/bootstrap/, which is applied first. That
# resolves the chicken-and-egg this stack used to paper over with an untracked, local-state
# `backend_override.tf`: there is now somewhere for the state to go before this stack runs, so no
# override is needed and none should exist. Migration runbook: docs/testing/e2e-state-migration.md.
terraform {
  backend "azurerm" {}
}
