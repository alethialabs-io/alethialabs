# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Invariants for the platform assumer identity. `check` blocks surface a warning on plan/apply if an
# invariant is violated (drift/misconfig fails loudly) without blocking a legitimate change.

# Apply in the intended platform account — the account the customer trust policies name. Creating the
# assumer in the wrong account would silently break every AssumeRole/WIF trust.
check "correct_platform_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.platform_account_id
    error_message = "Applying in account ${data.aws_caller_identity.current.account_id}, but platform_account_id is ${var.platform_account_id}. Switch credentials or set -var platform_account_id."
  }
}

# The assumer must be scoped to the customer provisioner-role NAME pattern — never sts:AssumeRole on a
# bare "*". A wildcard ACCOUNT is expected (any customer); the role name must carry the prefix.
check "assume_role_is_scoped" {
  assert {
    condition     = local.assume_role_resource != "*" && length(regexall("role/${var.customer_role_name_prefix}", local.assume_role_resource)) > 0
    error_message = "The assume-role resource must target the ${var.customer_role_name_prefix}* role-name pattern, not a bare wildcard."
  }
}

# The policy grants exactly the one action it needs (sts:AssumeRole) — nothing broader.
check "policy_is_least_privilege" {
  assert {
    # NB: compare as SETS — OpenTofu's `==` treats a list(string) (from tolist/flatten) as unequal to a
    # tuple literal `["sts:AssumeRole"]`, so the old `tolist(...) == [...]` was a false-negative that
    # fired on the correct single-action policy. `toset == toset` is type-consistent and order-free.
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.assume_customer_roles.policy).Statement :
      toset(flatten([s.Action])) == toset(["sts:AssumeRole"])
    ])
    error_message = "The assumer policy must grant only sts:AssumeRole."
  }
}

# The web-identity trust MUST pin both the OIDC subject and audience — otherwise any identity the issuer
# vouches for (or any audience) could assume the platform role. Assert each trust statement's
# StringEquals carries exactly a :sub and an :aud condition.
check "trust_pins_sub_and_aud" {
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role.assumer.assume_role_policy).Statement :
      can(s.Condition.StringEquals) &&
      length([for k in keys(s.Condition.StringEquals) : k if endswith(k, ":sub") || endswith(k, ":aud")]) == 2
    ])
    error_message = "The role trust policy must pin both the OIDC :sub and :aud conditions."
  }
}
