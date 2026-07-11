# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the GCP project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.

locals {
  # GCP resource ids (GKE cluster, Cloud SQL instance) are commonly capped around 40 characters.
  # The templates name them from "<environment>-<project_name>[-suffix]"; assert the stem is short.
  gcp_name_stem_len = length("${var.environment}-${var.project_name}")
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

# When a network is provisioned in-template, the primary/pod/service CIDRs must be valid.
check "network_cidrs_valid_when_provisioned" {
  assert {
    condition     = !var.provision_network || (can(cidrhost(var.network_cidr, 0)) && can(cidrhost(var.pods_cidr_range, 0)) && can(cidrhost(var.services_cidr_range, 0)))
    error_message = "provision_network is true but one of network_cidr / pods_cidr_range / services_cidr_range is not a valid IPv4 CIDR."
  }
}

# When an existing network is used (provision_network = false) its self-links must be supplied.
check "existing_network_ids_present" {
  assert {
    condition     = var.provision_network || (length(trimspace(var.network_id)) > 0 && length(trimspace(var.subnetwork_id)) > 0)
    error_message = "provision_network is false (existing network) but network_id or subnetwork_id is empty; supply both self-links."
  }
}

# A GKE Kubernetes master version must be set when GKE is provisioned.
check "gke_cluster_version_present" {
  assert {
    condition     = !var.provision_gke || length(trimspace(var.gke_cluster_version)) > 0
    error_message = "provision_gke is true but gke_cluster_version is empty."
  }
}

# Standard GKE clusters (non-Autopilot) keep nodes private by design; do not disable private nodes.
check "gke_private_nodes_when_standard" {
  assert {
    condition     = !var.provision_gke || var.gke_enable_autopilot || var.gke_enable_private_nodes
    error_message = "Standard GKE clusters must keep gke_enable_private_nodes = true (private nodes)."
  }
}

# When Cloud DNS is enabled, both the zone name and domain must be supplied.
check "cloud_dns_fields_present_when_enabled" {
  assert {
    condition     = !var.cloud_dns_enabled || (length(trimspace(var.cloud_dns_zone_name)) > 0 && length(trimspace(var.cloud_dns_domain)) > 0)
    error_message = "cloud_dns_enabled is true but cloud_dns_zone_name or cloud_dns_domain is empty."
  }
}

# The external-secrets GSA must exist whenever GKE is provisioned — without it the gcpsm
# ClusterSecretStore is (correctly) not rendered and ExternalSecrets can never sync.
check "external_secrets_gsa_present" {
  assert {
    condition     = !var.provision_gke || length(trimspace(try(google_service_account.external_secrets[0].email, ""))) > 0
    error_message = "provision_gke is true but the external-secrets Google service account reported no email — the ESO ClusterSecretStore cannot authenticate."
  }
}
