# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# VNet / subnet / DNS / brownfield-network invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

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

# When Azure CREATES the zone, the domain must be supplied — it is the zone's name.
#
# This used to also require `azure_dns_zone_name`, which was exactly backwards once
# `azure_dns_enabled` became the CREATE gate (#1992): that variable carries the id of a zone the
# user ALREADY owns, so it is empty precisely when we are creating one. Requiring both meant the
# only configuration the check accepted was the one that produced a duplicate zone.
#
# It was also the only thing in the template that read `azure_dns_zone_name` at all — and a `check`
# block never blocks an apply, so the variable was declared, "checked", and then ignored while the
# module created a second zone regardless.
check "azure_dns_fields_present_when_creating" {
  assert {
    condition     = !var.azure_dns_enabled || length(trimspace(var.azure_dns_domain)) > 0
    error_message = "azure_dns_enabled is true (creating a zone) but azure_dns_domain is empty; the domain IS the zone name."
  }
}

# Fail-closed brownfield-subnet gate (#1352): on an existing VNet a subnet MUST resolve — from the
# user's var.subnet_ids selection or the VNet's first subnet. An empty subnet name previously fell
# through to AKS and failed inside `tofu apply`; this precondition blocks it at plan time.
resource "terraform_data" "brownfield_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_vnet || length(trimspace(local.existing_subnet_name)) > 0
      error_message = "provision_vnet is false but no subnet resolved in VNet '${var.vnet_id}'. Select subnet_ids, or ensure the VNet has at least one subnet. Apply blocked fail-closed."
    }
  }
}
