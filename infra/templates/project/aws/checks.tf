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

# The external-secrets operator's IRSA role must exist whenever EKS is provisioned — without it
# the AWS ClusterSecretStore is (correctly) not rendered and ExternalSecrets can never sync.
check "eks_irsa_external_secrets_arn_present" {
  assert {
    condition     = !var.provision_eks || length(trimspace(try(module.eks[0].eks_irsa_external_secrets_arn, ""))) > 0
    error_message = "provision_eks is true but the external-secrets IRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}
