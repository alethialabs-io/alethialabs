# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the AWS project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.

locals {
  # The EKS cluster name derived in locals.tf: "eks-<region-short>-<environment>-<project_name>".
  # AWS caps the EKS cluster name at 100 characters.
  eks_cluster_name_len = length("eks-xxx-${var.environment}-${var.project_name}")
}

# project_name is the root of every naming convention and must be non-empty.
check "project_name_non_empty" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be non-empty (it seeds every resource name)."
  }
}

# The derived EKS cluster name must stay within the AWS 100-char cluster-name limit.
check "eks_cluster_name_within_limit" {
  assert {
    condition     = local.eks_cluster_name_len <= 100
    error_message = "Derived EKS cluster name (eks-<region>-${var.environment}-${var.project_name}) exceeds the AWS 100-character limit; shorten environment/project_name."
  }
}

# When a VPC is provisioned in-template, vpc_cidr must be a valid IPv4 CIDR.
check "vpc_cidr_valid_when_provisioned" {
  assert {
    condition     = !var.provision_vpc || can(cidrhost(var.vpc_cidr, 0))
    error_message = "provision_vpc is true but vpc_cidr is not a valid IPv4 CIDR (e.g. 10.0.0.0/16)."
  }
}

# When an external VPC is used (provision_vpc = false) its id must be supplied.
check "external_vpc_id_present" {
  assert {
    condition     = var.provision_vpc || length(trimspace(var.vpc_id)) > 0
    error_message = "provision_vpc is false (external VPC) but vpc_id is empty; supply the existing VPC id."
  }
}

# An EKS Kubernetes cluster version must be set when EKS is provisioned.
check "eks_cluster_version_present" {
  assert {
    condition     = !var.provision_eks || length(trimspace(var.eks_cluster_version)) > 0
    error_message = "provision_eks is true but eks_cluster_version is empty."
  }
}

# When an RDS cluster is created, a database name must be supplied.
check "rds_db_name_present_when_created" {
  assert {
    condition     = !var.create_rds || length(trimspace(var.rds_config.db_name)) > 0
    error_message = "create_rds is true but rds_config.db_name is empty; set a database name."
  }
}

# Keyless RDS IAM auth (#722): when the RDS engine flag is on, the app IRSA role must also be created
# (one iam_auth toggle drives both, via the provider tfvars) — otherwise the DB accepts IAM tokens but
# no workload identity can mint one and the keyless binding fails closed.
check "keyless_rds_iam_irsa_wired" {
  assert {
    condition     = !var.rds_iam_auth_enabled || length(module.rds_iam_auth) == 1
    error_message = "rds_iam_auth_enabled is on but the app RDS-IAM IRSA role is missing; set rds_iam_irsa (the iam_auth toggle should drive both)."
  }
}

# Every S3 bucket must keep public access blocked (block_public_acls / restrict_public_buckets must
# not be explicitly false). null is allowed — the module defaults those to a blocked posture.
check "s3_buckets_block_public_access" {
  assert {
    condition = alltrue([
      for b in var.bucket_configuration :
      b.block_public_acls != false && b.restrict_public_buckets != false
    ])
    error_message = "Every S3 bucket must keep block_public_acls and restrict_public_buckets non-false (public access blocked)."
  }
}

# Platform base tags must WIN over classification_tags: for every base key, the merged
# aws_default_tags must carry the base value (never a classification override). This guards the
# merge direction so a renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_tags_win" {
  assert {
    condition = alltrue([
      for k, v in local.aws_base_tags : local.aws_default_tags[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base tag in aws_default_tags; base tags must sit on the merge RHS and win."
  }
}

# No classification tag may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia:project-id / alethia:environment-id sweep handles on the tagged resources.
check "classification_tags_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.aws_default_tags[k] == v || contains(keys(local.aws_base_tags), k)
    ])
    error_message = "A classification_tags entry was dropped from aws_default_tags; classification/sweep-handle tags must reach tagged resources."
  }
}

# Karpenter-launched EC2 do NOT inherit the provider default_tags (Karpenter creates them via its
# own AWS API calls), so they only carry the sweep handle if the EC2NodeClass spec.tags is stamped
# from the `karpenter_node_tags` output (= local.aws_default_tags). Assert here that when Karpenter
# is enabled the classification/sweep-handle tags are all present in aws_default_tags, so the output
# can never ship without them and Karpenter EC2 can never escape the environment-scoped sweeper.
# (This is the plan-time invariant; whether the renderer actually applies spec.tags is proven by the
# A1.3 sweeper / A0.3-style cloud-side check on a real apply.)
check "karpenter_node_tags_carry_sweep_handle" {
  assert {
    condition = !var.enable_karpenter || alltrue([
      for k, v in var.classification_tags :
      local.aws_default_tags[k] == v || contains(keys(local.aws_base_tags), k)
    ])
    error_message = "Karpenter is enabled but classification/sweep-handle tags are not fully present in aws_default_tags (the karpenter_node_tags output); Karpenter-launched EC2 would escape the environment-scoped sweeper."
  }
}

# The external-secrets operator's IRSA role must exist whenever EKS is provisioned — without it
# the AWS ClusterSecretStore is (correctly) not rendered and ExternalSecrets can never sync.
check "eks_irsa_external_secrets_arn_present" {
  assert {
    condition     = !var.provision_eks || length(trimspace(try(module.eks[0].eks_irsa_external_secrets_arn, ""))) > 0
    error_message = "provision_eks is true but the external-secrets IRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}

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
