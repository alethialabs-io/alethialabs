# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ECR registry + cross-account pull invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# ECR provisioning must be REAL (W2): provision_ecr=true with an empty ecr_names_map used to
# create NOTHING — the module's for_each resolved to {} while the flag read true. The emitter
# (packages/core/cloud/aws_provider.go buildECRNamesMap) supplies one repo per native registry
# component / repo-sourced service; a true flag with no names is a broken caller.
check "ecr_names_present_when_provisioned" {
  assert {
    condition     = !var.provision_ecr || length(var.ecr_names_map) > 0
    error_message = "provision_ecr is true but ecr_names_map is empty — no repository would be created; the tfvars emitter must supply one entry per native registry / repo-sourced service."
  }
}


# Every ECR repo base name must be valid for the composed "<project_name>-<base>" repository
# (lowercase alphanumerics with ._- separators), or the apply fails mid-flight.
check "ecr_repo_base_names_valid" {
  assert {
    condition = alltrue([
      for k, v in var.ecr_names_map : can(regex("^[a-z0-9]+([._-][a-z0-9]+)*$", v))
    ])
    error_message = "ecr_names_map contains an invalid repo base name (must be lowercase alphanumerics with single ._- separators)."
  }
}


# The build IRSA role name must fit IAM's 64-char role-name limit (it embeds the EKS name).
check "ecr_build_role_name_within_limit" {
  assert {
    condition     = !var.provision_ecr || length("ecr-build-${local.eks_name}") <= 64
    error_message = "Derived build IRSA role name (ecr-build-<eks_name>) exceeds IAM's 64-character limit; shorten environment/project_name."
  }
}


# Cross-account ECR pull (PR B): if ecr-xacct is selected, the refresher needs a target-account role
# to assume — a missing ARN is a misconfigured connector, so fail the plan loudly.
check "ecr_pull_xacct_target_configured" {
  assert {
    condition     = !local.enable_ecr_pull || var.registry_pull_target_role_arn != ""
    error_message = "registry_pull_provider = ecr-xacct requires registry_pull_target_role_arn (the target-account role the refresher assumes for cross-account ECR pull)."
  }
}


# The cross-account pull IRSA role name must fit IAM's 64-char role-name limit (it embeds the EKS name).
check "ecr_pull_xacct_role_name_within_limit" {
  assert {
    condition     = !local.enable_ecr_pull || length("ecr-pull-xacct-${local.eks_name}") <= 64
    error_message = "Derived ecr-pull-xacct-<eks_name> role name exceeds IAM's 64-character limit; shorten environment/project_name."
  }
}
