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

  # Azure Key Vault names are 3-24 chars (alphanumeric + dashes, dashes DO count — unlike the storage
  # stem). modules/key-vault derives "<project_name>-<environment>-kv"; assert its length here.
  azure_key_vault_name     = "${var.project_name}-${var.environment}-kv"
  azure_key_vault_name_len = length(local.azure_key_vault_name)
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

# The Key Vault name "<project_name>-<environment>-kv" must fit Azure's 24-char limit — fail fast with a
# clear message instead of the cryptic azurerm "name may only contain ... 3-24 chars" plan error.
check "key_vault_name_within_limit" {
  assert {
    condition     = local.azure_key_vault_name_len <= 24
    error_message = "Key Vault name '${local.azure_key_vault_name}' is ${local.azure_key_vault_name_len} chars, over Azure's 24-character limit; shorten project_name/environment (e.g. environment 'dev' not 'development')."
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

# The external-secrets workload identity + the vault URI must exist whenever AKS is provisioned —
# without them the azurekv ClusterSecretStore is (correctly) not rendered and can never sync.
check "external_secrets_identity_present" {
  assert {
    condition     = !var.provision_aks || (length(trimspace(try(azurerm_user_assigned_identity.external_secrets[0].client_id, ""))) > 0 && startswith(module.key_vault.vault_uri, "https://"))
    error_message = "provision_aks is true but the external-secrets managed identity or Key Vault URI is missing — the ESO ClusterSecretStore cannot authenticate."
  }
}

# Platform base tags must WIN over classification_tags: for every base key, the merged
# azure_default_tags must carry the base value (never a classification override). Guards the merge
# direction so a renamed classification dimension can never shadow platform bookkeeping.
check "classification_base_tags_win" {
  assert {
    condition = alltrue([
      for k, v in local.azure_base_tags : local.azure_default_tags[k] == v
    ])
    error_message = "A classification_tags entry overrode a platform base tag in azure_default_tags; base tags must sit on the merge RHS and win."
  }
}

# BYOC B4.1 — cluster_admins → admin_group_object_ids must carry Entra group OBJECT IDs
# (GUIDs), never names. AKS rejects non-GUID admin group ids, so fail loudly at plan time.
check "aks_admin_group_object_ids_are_guids" {
  assert {
    condition = alltrue([
      for id in var.aks_admin_group_object_ids :
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", id))
    ])
    error_message = "aks_admin_group_object_ids must be Entra group OBJECT IDs (GUIDs), not group names — map cluster_admins' `groups` to object ids."
  }
}

# BYOC B4.1 — every AKS API-server authorized range must be a valid IPv4 CIDR, so a
# typo can't silently widen or break the allow-list.
check "aks_authorized_ip_ranges_valid_cidrs" {
  assert {
    condition = alltrue([
      for c in var.aks_authorized_ip_ranges : can(cidrhost(c, 0))
    ])
    error_message = "aks_authorized_ip_ranges entries must be valid IPv4 CIDRs (e.g. 203.0.113.0/24)."
  }
}

# BYOC B4.1 — every DB allow-listed CIDR must be a valid IPv4 CIDR (each expands to a
# start/end firewall IP range), so a malformed entry fails at plan time.
check "azure_db_allowed_cidrs_valid_cidrs" {
  assert {
    condition = alltrue([
      for c in var.azure_db_allowed_cidrs : can(cidrhost(c, 0))
    ])
    error_message = "azure_db_allowed_cidrs entries must be valid IPv4 CIDRs (e.g. 203.0.113.10/32)."
  }
}

# No classification tag may be silently dropped: every key in var.classification_tags must survive
# into the merged map verbatim, unless a platform base key legitimately overrode it. This lands the
# mandatory alethia:project-id / alethia:environment-id sweep handles on the tagged resources.
check "classification_tags_present" {
  assert {
    condition = alltrue([
      for k, v in var.classification_tags :
      local.azure_default_tags[k] == v || contains(keys(local.azure_base_tags), k)
    ])
    error_message = "A classification_tags entry was dropped from azure_default_tags; classification/sweep-handle tags must reach tagged resources."
  }
}

# BYOC AZ-SELF-ADMIN (mirror of aws/modules/eks/checks.tf) — an AKS cluster the apply-runner
# cannot administer is useless: with Azure RBAC for Kubernetes on, the runner's AAD token 401s
# and it can never install ArgoCD/add-ons. Fail the PLAN if no runner-reachable admin path is
# configured, so a future default flip can't silently brick provisioning instead of the plan.
check "aks_runner_admin_path" {
  assert {
    condition     = var.aks_enable_creator_admin || length(var.aks_admin_group_object_ids) > 0
    error_message = "AKS would have NO runner-reachable admin: set aks_enable_creator_admin=true (default — grants the apply-runner RBAC Cluster Admin), or provide aks_admin_group_object_ids. Without one, the runner cannot install ArgoCD."
  }
}
