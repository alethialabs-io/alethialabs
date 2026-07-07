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
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.assume_customer_roles.policy).Statement :
      tolist(flatten([s.Action])) == ["sts:AssumeRole"]
    ])
    error_message = "The assumer policy must grant only sts:AssumeRole."
  }
}
