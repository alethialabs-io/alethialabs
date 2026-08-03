# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-subscription ACR pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

# Cross-subscription ACR pull (PR B): when acr-xacct is selected (and AKS is provisioned) the cluster-
# side pull identity must exist (the refresher's federated Workload Identity). A missing UAMI = no mint.
check "acr_pull_xacct_identity_present" {
  assert {
    condition     = !local.enable_acr_pull || length(azurerm_user_assigned_identity.acr_pull) == 1
    error_message = "registry_pull_provider = acr-xacct but the cross-subscription ACR pull identity was not created."
  }
}
