# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time assertions on the template's invariants. `check` blocks surface a
# warning during plan/apply without blocking, keeping drift/misconfig loud.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks go in
# their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single shared
# append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # Kubernetes major/minor parsed from ack_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the Alibaba supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.alibaba = 1.33-1.35). Keep them in lockstep with
  # matrix.json (the Go/TS drift guards couplings_drift_test.go + apps/console check:compat keep code honest).
  ack_k8s_major = can(tonumber(split(".", var.ack_cluster_version)[0])) ? tonumber(split(".", var.ack_cluster_version)[0]) : -1
  ack_k8s_minor = can(tonumber(split(".", var.ack_cluster_version)[1])) ? tonumber(split(".", var.ack_cluster_version)[1]) : -1
}

check "project_name_present" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be a non-empty string."
  }
}

check "ack_cluster_name_present" {
  assert {
    condition     = !var.provision_ack || length(trimspace("${var.project_name}-${var.environment}")) > 0
    error_message = "When provision_ack is true, the derived ACK cluster name must be non-empty."
  }
}
