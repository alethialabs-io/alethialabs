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


# The subnet plan must stay internally disjoint. Two subnet lists that overlap are accepted by AWS
# subnet-by-subnet and only surface as unroutable addresses much later, so the invariant is checked
# rather than eyeballed. local.vpc_subnet_plan_spans expresses every subnet as a half-open interval
# in 1024ths of the VPC, straight from the (newbits, netnum) pairs — so this holds for any vpc_cidr
# size, and a future edit to a netnum in networking.tf is what would trip it.
# (checks_network_subnet_plan.tftest.hcl asserts the same property as a hard failure, since a
# `check` only WARNs.)
check "vpc_subnet_plan_disjoint" {
  assert {
    condition = alltrue([
      for p in setproduct(range(length(local.vpc_subnet_plan_spans)), range(length(local.vpc_subnet_plan_spans))) :
      p[0] >= p[1] ? true : (
        local.vpc_subnet_plan_spans[p[0]].end <= local.vpc_subnet_plan_spans[p[1]].start ||
        local.vpc_subnet_plan_spans[p[1]].end <= local.vpc_subnet_plan_spans[p[0]].start
      )
    ])
    error_message = "The VPC subnet plan in networking.tf overlaps itself: ${jsonencode(local.vpc_subnet_plan_spans)} (spans are 1024ths of the VPC). Two subnets sharing addresses is silent at create time and unrecoverable without replacing them."
  }
}


# A provisioned VPC must also be BIG ENOUGH to carry the subnet plan in networking.tf. The public
# subnets are 1/1024 of the VPC and AWS's smallest subnet is a /28, so the VPC must be /18 or wider;
# past /22 the `cidrsubnet(vpc, 10, …)` call cannot even evaluate (it would need a 33-bit prefix)
# and the plan dies on a raw function error naming no variable. WARN companion to the fail-closed
# precondition below.
#
# Deliberately NOT a `validation` block on var.vpc_cidr: a BROWNFIELD customer (provision_vpc =
# false) may legitimately pass their real, small VPC CIDR — locals.tf feeds it to
# redis_allowed_cidr_blocks — and a variable validation cannot see provision_vpc to tell the two
# cases apart.
check "vpc_cidr_large_enough_to_carve" {
  assert {
    condition     = !var.provision_vpc || local.vpc_cidr_is_carvable
    error_message = "vpc_cidr '${var.vpc_cidr}' is too small to carve the subnet plan: it must be /18 or wider (a /16 is the documented shape). The public subnets are 1/1024 of the VPC and AWS refuses any subnet smaller than /28."
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
# Fail-closed VPC-size gate. `check` blocks only WARN, so the guard that actually blocks the apply
# is a precondition. Without it a vpc_cidr of /19…/22 plans clean and then AWS rejects the public
# subnets at apply ("The CIDR '…/30' is invalid" — minimum /28), halfway through creating a VPC;
# and a /23 or smaller kills the plan inside cidrsubnet with an error that names no input.
resource "terraform_data" "vpc_cidr_carvable_guard" {
  lifecycle {
    precondition {
      condition     = !var.provision_vpc || local.vpc_cidr_is_carvable
      error_message = "provision_vpc is true but vpc_cidr '${var.vpc_cidr}' cannot carry the subnet plan. It must be a valid IPv4 CIDR of /18 or wider — 10.0.0.0/16 is the documented shape. Under the AWS VPC CNI every pod takes an address from the private subnet, so the plan gives each private subnet 1/16 of the VPC (a /20 on a /16); the public subnets are 1/1024, and AWS refuses any subnet smaller than /28. Apply blocked fail-closed."
    }
  }
}


resource "terraform_data" "brownfield_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.provision_vpc || (length(var.vpc_private_subnet_ids) > 0 && length(trimspace(var.vpc_private_subnet_ids[0])) > 0)
      error_message = "provision_vpc is false but no private subnets resolved for VPC '${var.vpc_id}'. Select subnets, or ensure the VPC's subnets are discoverable. Apply blocked fail-closed."
    }
  }
}
