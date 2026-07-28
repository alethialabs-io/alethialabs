# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# VPC / subnet / brownfield-import invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# When a VPC is provisioned in-template, vpc_cidr must be a valid IPv4 CIDR.
check "vpc_cidr_valid_when_provisioned" {
  assert {
    condition     = !var.provision_vpc || can(cidrhost(var.vpc_cidr, 0))
    error_message = "provision_vpc is true but vpc_cidr is not a valid IPv4 CIDR (e.g. 10.0.0.0/16)."
  }
}


# When an external VPC is used (provision_vpc = false) its id must be supplied.
check "external_vpc_id_present" {
  assert {
    condition     = var.provision_vpc || length(trimspace(var.vpc_id)) > 0
    error_message = "provision_vpc is false (external VPC) but vpc_id is empty; supply the existing VPC id."
  }
}


# When an external VPC is used, its private subnets must be resolved (either the user's subnet
# selection or auto-discovery in deploy.go). WARN companion to the fail-closed guard below (#1352) —
# catches the "subnet lookup failed → default [\"\"]" case that otherwise fails deep in apply.
check "external_vpc_subnets_present" {
  assert {
    condition     = var.provision_vpc || (length(var.vpc_private_subnet_ids) > 0 && length(trimspace(var.vpc_private_subnet_ids[0])) > 0)
    error_message = "provision_vpc is false but no private subnets resolved for vpc_id '${var.vpc_id}' — select subnets, or ensure the VPC's subnets are discoverable."
  }
}


# Fail-closed brownfield-subnet gate (#1352): on an external VPC the private subnet list MUST be
# non-empty and real (not the `[""]` default). deploy.go resolves it from the user's subnet
# selection (filtered) or auto-discovery; a failed lookup previously left `[""]` and blew up mid
# `tofu apply`. This precondition turns that into a hard plan-time block.
resource "terraform_data" "brownfield_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_vpc || (length(var.vpc_private_subnet_ids) > 0 && length(trimspace(var.vpc_private_subnet_ids[0])) > 0)
      error_message = "provision_vpc is false but no private subnets resolved for VPC '${var.vpc_id}'. Select subnets, or ensure the VPC's subnets are discoverable. Apply blocked fail-closed."
    }
  }
}
