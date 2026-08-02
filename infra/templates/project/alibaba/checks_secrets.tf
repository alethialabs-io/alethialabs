# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# RRSA workload-identity + external-secrets invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "ack_rrsa_provider_present" {
  assert {
    # The `try()` brings this into line with the identical assertion on aws (checks_secrets.tf),
    # which has always carried one, and with its own sibling below.
    #
    # To be precise about what it is and is not doing, because #1772 was fixed once on a false
    # premise: OpenTofu's short-circuiting IS reliable. `||` does not evaluate its right operand when
    # the left is a known `true`, so `!var.provision_ack || module.cluster[0]…` genuinely plans on a
    # cluster-less shape, with or without this `try()`. The protection is real — it is just
    # POSITIONAL. Reorder the disjuncts, or add a term in front, and the index is reached and the
    # plan dies with "Invalid index … module.cluster is empty tuple", which is precisely how
    # `provision_eks = false` stayed unplannable on aws for the whole life of that template.
    #
    # So this is belt-and-braces against a future edit, not a correctness fix, and it is cheap HERE
    # in a way it would not be elsewhere: the surrounding `length(trimspace(…)) > 0` already fails
    # the check on "", so a `try()` that swallowed a genuinely renamed module output would still be
    # reported loudly rather than passing silently.
    condition     = !var.provision_ack || length(trimspace(try(module.cluster[0].rrsa_oidc_provider_arn, ""))) > 0
    error_message = "ACK RRSA (workload identity) did not report an OIDC provider ARN — in-cluster components can't assume RAM roles."
  }
}

check "external_secrets_rrsa_role_present" {
  assert {
    condition     = !local.eso_rrsa_enabled || length(trimspace(try(alicloud_ram_role.external_secrets[0].arn, ""))) > 0
    error_message = "Native KMS secrets exist on an ACK cluster but the external-secrets RRSA role reported no ARN — the ESO ClusterSecretStore cannot authenticate."
  }
}
