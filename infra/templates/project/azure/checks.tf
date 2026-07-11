# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the Azure project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.

locals {
  # Azure Storage Account names are the tightest limit: 3-24 chars, lowercase alphanumeric only, and
  # are derived from environment + project_name (with separators stripped). Assert the alphanumeric
  # stem fits inside 24 chars so the derived account name cannot overflow.
  azure_storage_name_stem_len = length(replace(lower("${var.environment}${var.project_name}"), "/[^a-z0-9]/", ""))
}

# project_name is the root of every naming convention and must be non-empty.
check "project_name_non_empty" {
  assert {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must be non-empty (it seeds every resource name)."
  }
}

# The environment+project_name alphanumeric stem must fit the Azure Storage Account 24-char cap.
check "storage_account_name_within_limit" {
  assert {
    condition     = local.azure_storage_name_stem_len <= 24
    error_message = "environment+project_name alphanumeric stem exceeds the Azure Storage Account 24-character limit; shorten environment/project_name."
  }
}

# When a VNet is provisioned in-template, vnet_cidr must be a valid IPv4 CIDR.
check "vnet_cidr_valid_when_provisioned" {
  assert {
    condition     = !var.provision_vnet || can(cidrhost(var.vnet_cidr, 0))
    error_message = "provision_vnet is true but vnet_cidr is not a valid IPv4 CIDR (e.g. 10.0.0.0/16)."
  }
}

# When an existing VNet is used (provision_vnet = false) its resource id must be supplied.
check "existing_vnet_id_present" {
  assert {
    condition     = var.provision_vnet || length(trimspace(var.vnet_id)) > 0
    error_message = "provision_vnet is false (existing VNet) but vnet_id is empty; supply the existing VNet resource id."
  }
}

# An AKS Kubernetes version must be set when AKS is provisioned.
check "aks_cluster_version_present" {
  assert {
    condition     = !var.provision_aks || length(trimspace(var.aks_cluster_version)) > 0
    error_message = "provision_aks is true but aks_cluster_version is empty."
  }
}

# When an Azure Database flexible server is created, an engine must be specified.
check "azure_db_engine_present_when_created" {
  assert {
    condition     = !var.create_azure_db || length(trimspace(var.azure_db_engine)) > 0
    error_message = "create_azure_db is true but azure_db_engine is empty; set postgres or mysql."
  }
}

# Zone redundancy for Azure Cache for Redis requires the Premium SKU.
check "azure_cache_multi_az_requires_premium" {
  assert {
    condition     = !var.create_azure_cache || !var.azure_cache_multi_az || var.azure_cache_sku == "Premium"
    error_message = "azure_cache_multi_az (zone redundancy) requires azure_cache_sku = \"Premium\"."
  }
}

# When Azure DNS is enabled, both the zone name and domain must be supplied.
check "azure_dns_fields_present_when_enabled" {
  assert {
    condition     = !var.azure_dns_enabled || (length(trimspace(var.azure_dns_zone_name)) > 0 && length(trimspace(var.azure_dns_domain)) > 0)
    error_message = "azure_dns_enabled is true but azure_dns_zone_name or azure_dns_domain is empty."
  }
}
