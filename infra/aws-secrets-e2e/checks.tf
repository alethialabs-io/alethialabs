# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# The principal pattern is the ONLY thing narrowing an account-root trust down to one role. If it
# were ever loosened to "*" (or anything without both anchors), this stack would trust EVERY
# principal in account A to read the canary — and the e2e would still pass, so nothing else would
# catch it. Assert the shape rather than trusting review.
check "eso_role_pattern_is_narrow" {
  assert {
    condition     = startswith(var.cluster_eso_role_pattern, "eks-") && endswith(var.cluster_eso_role_pattern, "-secrets-operator")
    error_message = "cluster_eso_role_pattern must start with \"eks-\" and end with \"-secrets-operator\" — a broader pattern would let any principal in the cluster account assume the read role."
  }
}

check "eso_role_pattern_has_no_bare_wildcard" {
  assert {
    condition     = !contains(["*", "**"], trimspace(var.cluster_eso_role_pattern))
    error_message = "cluster_eso_role_pattern must not be a bare wildcard."
  }
}

# Cross-ACCOUNT is the whole point. Applying this in the cluster's own account would create a role
# that trusts itself and prove nothing about the account boundary, while the e2e reported PASS.
check "target_is_a_different_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id != var.cluster_account_id
    error_message = "This stack must be applied in the TARGET account (account B), which must differ from cluster_account_id (account A) — otherwise the e2e is not a cross-account test."
  }
}

# The store reads the secret through the region configured on the connector; a canary in another
# region simply is not found. Keep the two visibly coupled.
check "secret_has_a_version" {
  assert {
    condition     = aws_secretsmanager_secret_version.canary.secret_id != ""
    error_message = "The canary secret must carry a version — an empty secret would make the e2e's sha256 comparison vacuous."
  }
}

# `external_id` defaults to "", and that default REMOVES the sts:ExternalId condition from the
# trust policy (main.tf:59) — the trust then rests on the ArnLike aws:PrincipalArn condition alone.
#
# It stays optional on purpose: this stack mirrors the connector's own optional `external_id`
# field, and requiring it here would test something the product does not require. What it should
# not be is SILENT. A confused-deputy control that is absent because nobody passed a value looks
# exactly like one that was deliberately declined, and #3108 is a list of defaults that were taken
# without anyone deciding to take them.
#
# `check` (warn) rather than a precondition (block) is the same call gcp-e2e records at
# e2e-budget.tf:115-118: a documented, deliberate opt-out is not a defect to be refused.
check "external_id_is_a_decision_not_a_default" {
  assert {
    condition     = var.external_id != ""
    error_message = "external_id is empty, so the read role's trust policy carries NO sts:ExternalId condition and rests on the ArnLike aws:PrincipalArn condition alone. That is a supported configuration — the connector's external_id is optional too — but confirm it is what you meant, and pass TF_VAR_external_id to add the control."
  }
}
