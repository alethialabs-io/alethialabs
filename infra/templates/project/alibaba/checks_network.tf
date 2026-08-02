# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# VPC / vSwitch / brownfield-network invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "network_cidr_valid" {
  assert {
    condition     = !var.provision_network || can(cidrhost(var.network_cidr, 0))
    error_message = "When provision_network is true, network_cidr must be a valid IPv4 CIDR (e.g. 10.0.0.0/16)."
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

# When an existing VPC is used (provision_network = false) its id must be supplied. WARN companion
# to the fail-closed guard below (#1352).
check "existing_network_id_present" {
  assert {
    condition     = var.provision_network || length(trimspace(var.network_id)) > 0
    error_message = "provision_network is false (existing VPC) but network_id is empty; supply the existing VPC id."
  }
}

# Fail-closed brownfield-subnet gate (#1352): on an existing VPC at least one vSwitch MUST resolve —
# from the user's var.subnet_ids selection or auto-discovery. An empty list previously indexed
# local.vswitch_ids[0] out of bounds inside `tofu apply`; this precondition blocks it at plan time.
resource "terraform_data" "brownfield_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_network || length(local.vswitch_ids) > 0
      error_message = "provision_network is false but no vSwitch resolved for VPC '${var.network_id}'. Select subnet_ids, or ensure the existing VPC has at least one vSwitch. Apply blocked fail-closed."
    }
  }
}
