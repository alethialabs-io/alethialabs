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

check "external_secrets_rrsa_role_present" {
  assert {
    condition     = !local.eso_rrsa_enabled || length(trimspace(try(alicloud_ram_role.external_secrets[0].arn, ""))) > 0
    error_message = "Native KMS secrets exist on an ACK cluster but the external-secrets RRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}

# Platform base tags must WIN over classification_tags: for every base key, the merged common_tags
# must carry the base value (never a classification override). Guards the merge direction so a
# renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_tags_win" {
  assert {
    condition = alltrue([
      for k, v in local.common_base_tags : local.common_tags[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base tag in common_tags; base tags must sit on the merge RHS and win."
  }
}

# No classification tag may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia:project-id / alethia:environment-id sweep handles on the tagged resources.
check "classification_tags_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.common_tags[k] == v || contains(keys(local.common_base_tags), k)
    ])
    error_message = "A classification_tags entry was dropped from common_tags; classification/sweep-handle tags must reach tagged resources."
  }
}

# PLAN-OUT SAFETY (#621, the alibaba twin of aws #608): the vswitch count must be the
# static var.vswitch_count — never derived from the zones DATA SOURCE, which is unknown
# at plan under the runner's keyless RAM-OIDC provider (credentials resolve at apply).
check "vswitch_count_static_and_sane" {
  assert {
    condition     = var.vswitch_count >= 1 && var.vswitch_count <= 8
    error_message = "vswitch_count must be a static number between 1 and 8 (a zones-data-source-derived count is unknown at plan and fails the runner's plan-out)."
  }
}
