# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Keyless OCI Helm chart-repo pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# Keyless OCI ECR Helm chart-repo pull (#1185): the pull identity must be scoped — if it is enabled, at
# least one grant source (a private target role or the public flag) must be present, so an enabled-but-
# empty policy (which would be a bug) fails the plan loudly rather than provisioning a do-nothing role.
check "helm_repo_pull_grant_present_when_enabled" {
  assert {
    condition     = !local.enable_helm_repo_pull || length(var.helm_repo_pull_target_role_arns) > 0 || var.helm_repo_pull_public_enabled
    error_message = "helm_repo_pull is enabled but neither a target role ARN nor the public flag is set (the pull policy would be empty)."
  }
}


# The keyless Helm pull IRSA role name must fit IAM's 64-char role-name limit (it embeds the EKS name).
# Keyed on `helm_repo_pull_requested`, NOT `enable_helm_repo_pull`: the build predicate gained
# `var.provision_eks` in #1772, and keying on it would silently disarm this bound on every
# cluster-less shape. `local.eks_name` is derived from environment/project_name and exists whether
# or not the cluster does, so a too-long name is worth reporting before the cluster is switched on.
check "helm_repo_pull_role_name_within_limit" {
  assert {
    condition     = !local.helm_repo_pull_requested || length("helm-repo-pull-${local.eks_name}") <= 64
    error_message = "Derived helm-repo-pull-<eks_name> role name exceeds IAM's 64-character limit; shorten environment/project_name."
  }
}
