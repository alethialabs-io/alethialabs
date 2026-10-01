# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# This stack's state lives in the container this stack creates. That is not circular in practice:
# the FIRST apply runs on local state under a TEMPORARY `backend_override.tf` forcing
# `backend "local" {}`, the override is deleted, and a single documented
# `tofu init -backend-config=backend.hcl -migrate-state` then moves it in. Every apply after
# that is plain remote state. Runbook: docs/testing/e2e-state-migration.md.
#
# `tofu init -backend=false` is NOT enough for that first apply, whatever this comment once said:
# `apply` plans first, and the plan refuses with "Backend initialization required … Initial
# configuration of the requested backend "azurerm"" (exit 1). `-backend=false` serves `validate`
# and `test` only.
terraform {
  backend "azurerm" {}
}
