# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A3.1 — loud invariant assertions on the e2e-nightly RAM role. A `check` block fails the
# plan/apply if any security property regresses, so a mis-scoped trust, a wildcarded subject, or an
# admin-grade policy can never ship silently. Mirrors infra/aws-oidc/checks.tf; the properties are
# the ones controls_alibaba.go (the verify gate) enforces on provisioning plans, asserted here on
# the trust/policy this stack itself creates.

# ── The OIDC subject is EXACT and non-wildcarded (ALI-OIDC-001 shape) ─────────
check "e2e_subject_exact_non_wildcard" {
  assert {
    condition     = can(regex("^repo:[^:*]+/[^:*]+:ref:refs/heads/[^:*]+$", local.e2e_sub))
    error_message = "e2e OIDC subject must be an EXACT repo:<owner>/<repo>:ref:refs/heads/<branch> with no '*' wildcard — got '${local.e2e_sub}'."
  }
}

# ── The trust binds sub/aud/iss with StringEquals, never StringLike ───────────
check "e2e_trust_uses_string_equals" {
  assert {
    condition = alltrue([
      contains(keys(local.trust_document.Statement[0].Condition), "StringEquals"),
      !contains(keys(local.trust_document.Statement[0].Condition), "StringLike"),
      lookup(local.trust_document.Statement[0].Condition.StringEquals, "oidc:sub", "") == local.e2e_sub,
      lookup(local.trust_document.Statement[0].Condition.StringEquals, "oidc:aud", "") == var.oidc_audience,
      lookup(local.trust_document.Statement[0].Condition.StringEquals, "oidc:iss", "") == var.github_issuer_url,
    ])
    error_message = "e2e trust must pin oidc:sub (exact), oidc:aud and oidc:iss with StringEquals (never StringLike)."
  }
}

# ── The trust is a Federated (OIDC) sts:AssumeRole — the RRSA/OIDC shape ──────
check "e2e_trust_is_federated_oidc" {
  assert {
    condition = alltrue([
      contains(keys(local.trust_document.Statement[0].Principal), "Federated"),
      local.trust_document.Statement[0].Action == "sts:AssumeRole",
      lower(local.trust_document.Statement[0].Effect) == "allow",
    ])
    error_message = "e2e trust must Allow sts:AssumeRole for a Federated (OIDC) principal."
  }
}

# ── The provisioning policy is least-priv: no bare '*' action, no RAM-admin ───
check "e2e_policy_no_admin_grant" {
  assert {
    condition = alltrue([
      # Never the bare '*' admin action (ALI-LEASTPRIV-001 hard fail: Action:'*' on Resource:'*').
      !contains(local.provision_actions, "*"),
      # Never a full-RAM grant — a principal that can create/attach RAM entities is admin one hop
      # away (the AliyunRAMFullAccess footgun ALI-LEASTPRIV-001 hard-fails).
      !contains(local.provision_actions, "ram:*"),
      # The only ram: actions permitted are the three non-escalating service-linked-role verbs.
      alltrue([
        for a in local.provision_actions :
        !startswith(a, "ram:") || contains([
          "ram:CreateServiceLinkedRole", "ram:DeleteServiceLinkedRole", "ram:GetServiceLinkedRoleDeletionStatus"
        ], a)
      ]),
    ])
    error_message = "e2e provisioning policy must not grant '*' or 'ram:*' (or any ram: action beyond the three service-linked-role verbs)."
  }
}

# ── The policy is a CUSTOM policy, never an admin System managed policy ───────
check "e2e_policy_is_custom" {
  assert {
    condition     = alicloud_ram_role_policy_attachment.e2e_provision.policy_type == "Custom"
    error_message = "e2e role must attach a least-privilege Custom policy, never a System admin policy (AdministratorAccess / AliyunRAMFullAccess)."
  }
}

# ── Region is not a prod region (no prod Alibaba footprint today; tripwire for later) ──
check "e2e_region_not_prod" {
  assert {
    condition     = !contains(var.prod_regions, var.region)
    error_message = "region must not be one of prod_regions."
  }
}

# ── If an expected account id was pinned, the applying identity must match it ──
check "e2e_applies_in_expected_account" {
  assert {
    condition     = var.account_id == "" || data.alicloud_caller_identity.current.account_id == var.account_id
    error_message = "this bootstrap is being applied in account ${data.alicloud_caller_identity.current.account_id}, but account_id pins ${var.account_id}."
  }
}
