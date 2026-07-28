# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-time invariant checks for the Azure project template (per infra IaC rule #2). These assert the
# naming, hardening, and conditional-completeness invariants the design depends on, so a careless
# edit or bad tfvars fails loudly at plan time rather than provisioning something broken/insecure.
#
# CONVENTION: this file holds only the CORE, rarely-touched invariants. A new feature's checks go in
# their own checks_<feature>.tf — OpenTofu loads every *.tf in the directory, and a single shared
# append-point is what made concurrent feature branches conflict here repeatedly.

locals {
  # Azure Storage Account names are the tightest limit: 3-24 chars, lowercase alphanumeric only, and
  # are derived from environment + project_name (with separators stripped). Assert the alphanumeric
  # stem fits inside 24 chars so the derived account name cannot overflow.
  azure_storage_name_stem_len = length(replace(lower("${var.environment}${var.project_name}"), "/[^a-z0-9]/", ""))

  # Azure Key Vault names are 3-24 chars (alphanumeric + dashes, dashes DO count — unlike the storage
  # stem). modules/key-vault derives "<project_name>-<environment>-kv"; assert its length here.
  azure_key_vault_name     = "${var.project_name}-${var.environment}-kv"
  azure_key_vault_name_len = length(local.azure_key_vault_name)

  # Kubernetes major/minor parsed from aks_cluster_version ("1.35" -> 1 / 35). -1 when unparseable, so a
  # missing/garbage version fails the COMPAT-001 guard closed rather than passing vacuously. The window
  # literals below are the Azure supported minors from the compat matrix
  # (packages/core/compat/matrix.json -> k8s_cloud.azure = 1.33-1.35). Keep them in lockstep with
  # matrix.json (the Go/TS drift guards couplings_drift_test.go + apps/console check:compat keep code honest).
  aks_k8s_major = can(tonumber(split(".", var.aks_cluster_version)[0])) ? tonumber(split(".", var.aks_cluster_version)[0]) : -1
  aks_k8s_minor = can(tonumber(split(".", var.aks_cluster_version)[1])) ? tonumber(split(".", var.aks_cluster_version)[1]) : -1
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

# An AKS Kubernetes version must be set when AKS is provisioned.
check "aks_cluster_version_present" {
  assert {
    condition     = !var.provision_aks || length(trimspace(var.aks_cluster_version)) > 0
    error_message = "provision_aks is true but aks_cluster_version is empty."
  }
}

# The ACR module and the output that reads it must agree about whether it exists.
#
# They didn't: the module's count required `registry_provider == "native"` while the output only
# checked `provision_acr`, and the console derives that flag from the PRESENCE of a registry row, not
# its provider. Selecting any registry connector therefore indexed [0] of an empty module and failed
# the whole apply with "Invalid index". The output now guards on `length(module.acr)`; this asserts
# the pairing so a future edit can't reintroduce the skew silently.
check "acr_output_matches_module" {
  assert {
    condition     = (length(module.acr) > 0) == (var.provision_acr && var.registry_provider == "native")
    error_message = "The ACR module count and its provisioning predicate have diverged — a pluggable registry_provider means the ACR is not created, and any output reading module.acr[0] would fail the apply."
  }
}
