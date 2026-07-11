# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time assertions on the template's invariants. `check` blocks surface a
# warning during plan/apply without blocking, keeping drift/misconfig loud.

check "project_name_present" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be a non-empty string."
  }
}

check "network_cidr_valid" {
  assert {
    condition     = !var.provision_network || can(cidrhost(var.network_cidr, 0))
    error_message = "When provision_network is true, network_cidr must be a valid IPv4 CIDR (e.g. 10.0.0.0/16)."
  }
}

check "rds_engine_present" {
  assert {
    condition     = !var.create_rds || length(trimspace(var.rds_engine)) > 0
    error_message = "When create_rds is true, rds_engine must be a non-empty string (e.g. PostgreSQL)."
  }
}

check "ack_cluster_name_present" {
  assert {
    condition     = !var.provision_ack || length(trimspace("${var.project_name}-${var.environment}")) > 0
    error_message = "When provision_ack is true, the derived ACK cluster name must be non-empty."
  }
}

check "ack_rrsa_provider_present" {
  assert {
    condition     = !var.provision_ack || length(trimspace(module.cluster[0].rrsa_oidc_provider_arn)) > 0
    error_message = "ACK RRSA (workload identity) did not report an OIDC provider ARN — in-cluster components can't assume RAM roles."
  }
}
