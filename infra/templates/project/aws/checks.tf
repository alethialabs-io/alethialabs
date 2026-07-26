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

  # Kubernetes major/minor parsed from eks_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the AWS supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.aws = 1.33-1.35). These are the SSOT mirror at the
  # IaC layer: keep them in lockstep with matrix.json (the Go/TS drift guards
  # packages/core/compat/couplings_drift_test.go + apps/console check:compat keep the code side honest).
  eks_k8s_major = can(tonumber(split(".", var.eks_cluster_version)[0])) ? tonumber(split(".", var.eks_cluster_version)[0]) : -1
  eks_k8s_minor = can(tonumber(split(".", var.eks_cluster_version)[1])) ? tonumber(split(".", var.eks_cluster_version)[1]) : -1
}
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks
# go in their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single
# shared append-point is what made concurrent feature branches conflict here repeatedly.

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


# An EKS Kubernetes cluster version must be set when EKS is provisioned.
check "eks_cluster_version_present" {
  assert {
    condition     = !var.provision_eks || length(trimspace(var.eks_cluster_version)) > 0
    error_message = "provision_eks is true but eks_cluster_version is empty."
  }
}
