# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Application Gateway / AGIC / WAF-attachment invariants.
# Split out per the IaC rule that each feature owns its checks file; never append to checks.tf.

# An EXPLICIT gateway request on a brownfield network must FAIL, not silently produce nothing.
# A gateway needs a dedicated subnet (see modules/vnet azurerm_subnet.application_gateway) and this
# template will not carve subnets in a VNet it does not own, so there is no shape that satisfies
# both. A `check` block would be wrong here: checks never block an apply, and the failure mode this
# guards is an operator who set the flag, saw a green apply, and has no ingress.
#
# The IMPLIED request (azure_waf_enabled on a brownfield network, with the flag left null) is a
# WARNING instead — see below. Refusing it would break projects that plan today.
resource "terraform_data" "application_gateway_subnet_guard" {
  lifecycle {
    precondition {
      condition     = var.azure_application_gateway_enabled != true || var.provision_vnet
      error_message = "azure_application_gateway_enabled is true but provision_vnet is false. An Application Gateway v2 requires a DEDICATED subnet that holds nothing else, and this template only carves one inside the VNet it creates — it will not add subnets to a VNet you brought. Provision the VNet in-template, or leave the gateway off and expose services with the ingress-nginx add-on. Apply blocked fail-closed."
    }
  }
}

# A WAF policy with nowhere to bind. This is the pre-lane state of EVERY Azure project that turned
# the switch on: modules/azure-waf built the policy, and nothing on the account referenced it.
# Advisory rather than blocking, deliberately — those projects still plan, and the runner records
# the same fact as a `waf` InfraServiceDecision the console can show.
check "azure_waf_policy_is_attached" {
  assert {
    condition     = !var.azure_waf_enabled || local.app_gateway_waf_attached
    error_message = "azure_waf_enabled is true but no Application Gateway will be created, so the WAF policy attaches to nothing: it will be created, billed, and will inspect zero requests. On Azure a WAF policy binds to an Application Gateway (firewall_policy_id) — there is no Ingress annotation equivalent. Leave azure_application_gateway_enabled unset (it then follows this switch) and provision the VNet in-template."
  }
}

# The other half of the same story: AGIC is the piece that turns Kubernetes Ingress objects into
# gateway listeners and rules. A gateway without it is reachable but static — nothing in the
# cluster can publish through it — which is a legitimate cluster-less shape, but not one to leave
# an operator to infer from an empty ingress list.
check "application_gateway_has_a_controller" {
  assert {
    condition     = !local.enable_application_gateway || local.enable_agic
    error_message = "An Application Gateway will be created but provision_aks is false, so no Application Gateway Ingress Controller will be installed: the gateway will bill and serve only its placeholder 502 backend, because nothing will be translating Ingress objects into its configuration."
  }
}
