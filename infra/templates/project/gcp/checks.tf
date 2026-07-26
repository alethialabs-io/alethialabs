# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the GCP project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks go in
# their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single shared
# append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # GCP resource ids (GKE cluster, Cloud SQL instance) are commonly capped around 40 characters.
  # The templates name them from "<environment>-<project_name>[-suffix]"; assert the stem is short.
  gcp_name_stem_len = length("${var.environment}-${var.project_name}")

  # Kubernetes major/minor parsed from gke_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the GCP supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.gcp = 1.33-1.35). Keep them in lockstep with
  # matrix.json (the Go/TS drift guards couplings_drift_test.go + apps/console check:compat keep code honest).
  gke_k8s_major = can(tonumber(split(".", var.gke_cluster_version)[0])) ? tonumber(split(".", var.gke_cluster_version)[0]) : -1
  gke_k8s_minor = can(tonumber(split(".", var.gke_cluster_version)[1])) ? tonumber(split(".", var.gke_cluster_version)[1]) : -1
}

# project_name is the root of every naming convention and must be non-empty.
check "project_name_non_empty" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be non-empty (it seeds every resource name)."
  }
}

# The <environment>-<project_name> naming stem must stay short enough for GKE / Cloud SQL ids
# (which cap around 40 chars, minus room for per-resource suffixes).
check "gcp_name_stem_within_limit" {
  assert {
    condition     = local.gcp_name_stem_len <= 30
    error_message = "environment-project_name stem exceeds 30 chars; GKE/Cloud SQL resource ids will overflow their ~40-char cap once suffixed."
  }
}

# A GKE Kubernetes master version must be set when GKE is provisioned.
check "gke_cluster_version_present" {
  assert {
    condition     = !var.provision_gke || length(trimspace(var.gke_cluster_version)) > 0
    error_message = "provision_gke is true but gke_cluster_version is empty."
  }
}
