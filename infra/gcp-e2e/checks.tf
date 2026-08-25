# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A2.1 — loud invariant assertions on the e2e GCP WIF federation. A `check` block fails the
# plan/apply (loudly) if any security property regresses — so a widened trust, a dropped
# container.admin, a runaway budget, or a prod region can never ship silently. Mirrors
# infra/aws-oidc/checks.tf.

# ── Trust is repo+ref-bound, exact-match, never wildcarded ───────────────────
check "e2e_trust_is_ref_bound" {
  assert {
    condition = alltrue([
      # Both the repo AND the ref appear in the provider's attribute condition …
      strcontains(local.e2e_attr_condition, var.github_repo),
      strcontains(local.e2e_attr_condition, var.e2e_github_ref),
      # … joined by exact equality (CEL `==`) and AND-ed (repo AND ref, not either) …
      strcontains(local.e2e_attr_condition, "=="),
      strcontains(local.e2e_attr_condition, "&&"),
      # … with no glob/wildcard that could widen the match.
      !strcontains(local.e2e_attr_condition, "*"),
    ])
    error_message = "e2e WIF provider attribute_condition must pin BOTH attribute.repository AND attribute.ref with exact `==` (no '*') — got: ${local.e2e_attr_condition}."
  }
}

# ── An environment disjunct, when present, is an EXACT subject and nothing wider ───────────────
# The condition may admit a second subject (a dispatch that declared the branch-restricted GitHub
# environment). That widening is only acceptable while it stays an exact `assertion.sub` equality: a
# prefix, a glob, or a bare second ref would trust every workflow on that branch instead of only the
# environment-gated job. Vacuous by design when no environment is configured.
check "e2e_env_subject_is_exact_when_present" {
  assert {
    condition = var.e2e_github_environment == "" ? !strcontains(local.e2e_attr_condition, "assertion.sub") : alltrue([
      # the disjunct exists, keyed on the SUBJECT (not on a second ref) …
      strcontains(local.e2e_attr_condition, "assertion.sub == \"${local.e2e_env_subject}\""),
      # … the subject is the canonical `environment:` form, so it cannot be a ref in disguise …
      startswith(local.e2e_env_subject, "repo:${var.github_repo}:environment:"),
      # … and the ref clause is still there: this ADDS a subject, it never replaces the ref binding.
      strcontains(local.e2e_attr_condition, "attribute.ref == \"${var.e2e_github_ref}\""),
    ])
    error_message = "with e2e_github_environment set, the attribute_condition must ADD an exact `assertion.sub == repo:<repo>:environment:<env>` disjunct while KEEPING the ref equality — got: ${local.e2e_attr_condition}."
  }
}

# ── The provider actually carries that condition (not just the local) ─────────
check "e2e_provider_condition_applied" {
  assert {
    condition     = google_iam_workload_identity_pool_provider.e2e.attribute_condition == local.e2e_attr_condition
    error_message = "the e2e WIF provider's attribute_condition must equal the ref-bound local.e2e_attr_condition — a drift here would relax the trust."
  }
}

# ── The trust roots at GitHub's OIDC issuer ──────────────────────────────────
check "e2e_provider_trusts_github_issuer" {
  assert {
    condition     = var.github_oidc_issuer == "https://token.actions.githubusercontent.com"
    error_message = "e2e WIF provider must trust the GitHub Actions OIDC issuer (https://token.actions.githubusercontent.com)."
  }
}

# ── The SA is impersonated only by the repo-scoped WIF principal ─────────────
check "e2e_wif_binding_is_repo_scoped" {
  assert {
    condition = alltrue([
      google_service_account_iam_member.e2e_wif.role == "roles/iam.workloadIdentityUser",
      strcontains(google_service_account_iam_member.e2e_wif.member, "principalSet://"),
      strcontains(google_service_account_iam_member.e2e_wif.member, "attribute.repository/${var.github_repo}"),
      !strcontains(google_service_account_iam_member.e2e_wif.member, "*"),
    ])
    error_message = "the e2e SA must be impersonable ONLY by the repo-scoped WIF principalSet (attribute.repository/${var.github_repo}), via roles/iam.workloadIdentityUser, with no wildcard."
  }
}

# ── GKE self-admin: roles/container.admin is bound (no template RBAC change needed) ──
check "e2e_container_admin_bound" {
  assert {
    condition     = contains(local.e2e_provisioner_roles, "roles/container.admin")
    error_message = "the e2e provisioner SA must be granted roles/container.admin (GKE self-admin at create time) — the whole point of the GCP parity proof."
  }
}

# ── The CMK path (#2092) is grantable: KMS management + the service-enablement READ it plans on ──
#
# Two halves of one failure. #2092 turned GKE Secrets envelope encryption on by default and #2269
# added a plan-time guard that READS whether cloudkms.googleapis.com is enabled. Dropping either the
# KMS role (403 at google_kms_key_ring, mid-cluster-build) or the serviceusage read (a plan-time
# error on the guard that never mentions KMS) reds this leg in a way that reads as a product bug.
# Both are asserted here so a future tightening pass has to notice them.
check "e2e_cmk_path_is_grantable" {
  assert {
    condition     = contains(local.e2e_provisioner_roles, "roles/cloudkms.admin")
    error_message = "the e2e provisioner SA must be granted roles/cloudkms.admin — #2092 creates a customer-managed key on every GKE cluster by default, so without it the apply 403s at google_kms_key_ring after the guard has already passed."
  }
}

# Same reasoning as the CMK grant above, and the same cost profile: `roles/dns.admin` does NOT carry
# the zone-scoped IAM verbs despite its name, so google_dns_managed_zone_iam_member 403s. That is
# invisible to every floor run and surfaces ~48 minutes into a full bar, which is exactly the kind of
# hard-won grant a future tightening pass would remove without noticing.
check "e2e_dns_zone_iam_is_grantable" {
  assert {
    condition = alltrue([
      contains(google_project_iam_custom_role.e2e_dns_zone_iam.permissions, "dns.managedZones.getIamPolicy"),
      contains(google_project_iam_custom_role.e2e_dns_zone_iam.permissions, "dns.managedZones.setIamPolicy"),
    ])
    error_message = "alethiaE2eDnsZoneIam must carry BOTH dns.managedZones.getIamPolicy and setIamPolicy — roles/dns.admin does not include them, and without them a DNS-enabled environment 403s at google_dns_managed_zone_iam_member deep into the apply."
  }
}

check "e2e_service_enablement_is_readable" {
  assert {
    condition = alltrue([
      contains(google_project_iam_custom_role.e2e_project_reader.permissions, "serviceusage.services.get"),
      # …and never the enable verb, which was refused on 2026-08-03 (#1844) and stays refused.
      !contains(google_project_iam_custom_role.e2e_project_reader.permissions, "serviceusage.services.enable"),
    ])
    error_message = "the e2e provisioner SA must be able to READ service-enablement state (serviceusage.services.get — roles/browser does not carry it, which is why alethiaE2eProjectReader replaces it) and must NEVER hold serviceusage.services.enable."
  }
}

# ── The cost guard exists and is sanely bounded, scoped to the dedicated project ──
check "e2e_budget_is_cost_capped" {
  assert {
    condition = alltrue([
      google_billing_budget.e2e_nightly.amount[0].specified_amount[0].currency_code == "USD",
      tonumber(google_billing_budget.e2e_nightly.amount[0].specified_amount[0].units) > 0,
      tonumber(google_billing_budget.e2e_nightly.amount[0].specified_amount[0].units) <= 500,
    ])
    error_message = "e2e budget must be a USD budget with 0 < amount <= 500."
  }
}

check "e2e_budget_scoped_to_project" {
  assert {
    condition     = contains(google_billing_budget.e2e_nightly.budget_filter[0].projects, "projects/${data.google_project.this.number}")
    error_message = "the e2e budget must be scoped to EXACTLY the dedicated e2e project (never account-wide)."
  }
}

check "e2e_budget_publishes_to_pubsub" {
  assert {
    condition     = google_billing_budget.e2e_nightly.all_updates_rule[0].pubsub_topic == google_pubsub_topic.e2e_budget.id
    error_message = "the e2e budget must publish its alerts to the e2e Pub/Sub topic."
  }
}

# ── region is never a prod-adjacent region ───────────────────────────────────
check "e2e_region_not_prod" {
  assert {
    condition     = !contains(["us-central1", "us-east1"], var.region)
    error_message = "region must not be a prod-adjacent region (us-central1 / us-east1)."
  }
}
