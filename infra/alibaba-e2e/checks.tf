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
    # EVERY subject in the list, not just the first. The list gained a second entry (an `environment:`
    # subject for a branch-restricted dispatch), and a check that validated only `local.e2e_sub` would
    # have waved the new one through unexamined — the "decision must mirror the emitter" failure.
    condition = alltrue([
      for s in local.e2e_subs :
      can(regex("^repo:[^:*]+/[^:*]+:(ref:refs/heads/[^:*]+|environment:[^:*]+)$", s))
    ])
    error_message = "every e2e OIDC subject must be an EXACT repo:<owner>/<repo>:ref:refs/heads/<branch> (or :environment:<env>) with no '*' wildcard — got ${jsonencode(local.e2e_subs)}."
  }
}

# ── The REF subject always exists; an environment only ever ADDS ──────────────
# The ref-bound trust is what the scheduled nightly federates as, and it must never be replaced by an
# environment subject — that would make the cron unable to assume the role while the config still
# looked trusted.
check "e2e_ref_subject_is_always_present" {
  assert {
    condition     = contains(local.e2e_subs, local.e2e_sub)
    error_message = "the ref-bound subject '${local.e2e_sub}' must remain in the trusted set — an environment subject ADDS, it never replaces (the scheduled nightly federates by ref)."
  }
}

# ── No environment subject unless one was asked for ───────────────────────────
check "e2e_env_subject_only_when_configured" {
  assert {
    condition     = var.e2e_github_environment != "" ? length(local.e2e_subs) == 2 : length(local.e2e_subs) == 1
    error_message = "the trusted-subject list must hold exactly the ref subject (no environment) or the ref + environment pair — got ${jsonencode(local.e2e_subs)} for environment '${var.e2e_github_environment}'."
  }
}

# ── The trust binds sub/aud/iss with StringEquals, never StringLike ───────────
check "e2e_trust_uses_string_equals" {
  assert {
    condition = alltrue([
      contains(keys(local.trust_document.Statement[0].Condition), "StringEquals"),
      !contains(keys(local.trust_document.Statement[0].Condition), "StringLike"),
      lookup(local.trust_document.Statement[0].Condition.StringEquals, "oidc:sub", []) == local.e2e_subs,
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
