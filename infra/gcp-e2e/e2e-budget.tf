# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BYOC A2.1 — cost kill-signal for the e2e GCP nightly. A monthly Cloud Billing Budget scoped to the
# DEDICATED e2e project, alerting at 50/80/100% (actual) + 100% (forecast) onto a Pub/Sub topic (so a
# maintainer can later hang an automated project kill-switch off it). The GCP analogue of the AWS
# Budget + SNS in infra/aws-oidc/e2e-budget.tf. A safety net on top of the always()-teardown — the
# nightly is a single tiny ephemeral cluster, so real spend should sit far under the ceiling; a breach
# means a leak or a stuck run.

# Programmatic budget notifications publish here. The Cloud Billing budgets service account needs
# roles/pubsub.publisher on this topic for delivery — granted below.
resource "google_pubsub_topic" "e2e_budget" {
  name    = "alethia-e2e-nightly-budget-alerts"
  project = var.project_id

  depends_on = [google_project_service.apis]
}

resource "google_billing_budget" "e2e_nightly" {
  billing_account = var.billing_account_id
  display_name    = "alethia-e2e-nightly"

  # Scope the budget to EXACTLY the dedicated e2e project (never account-wide).
  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.e2e_monthly_budget_usd)
    }
  }

  # Actual-spend alerts at 50 / 80 / 100 %, plus a forecast alert at 100 % (warns before the ceiling
  # is actually hit).
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.e2e_budget.id
    schema_version = "1.0"
  }
}

# ──────────────  The publisher binding, and why it is OFF until a human turns it on  ──────────────
#
# Delivery of these notifications needs `billing-budgets@system.gserviceaccount.com` to hold
# roles/pubsub.publisher on the topic. Granting it fails on this billing account:
#
#   Error applying IAM policy for pubsub topic ".../alethia-e2e-nightly-budget-alerts":
#   Service account billing-budgets@system.gserviceaccount.com does not exist.
#
# WHAT WE TRIED, AND WHAT IT PROVED (#1871). The first theory was that the agent is created lazily,
# at billing-account level, the first time a Pub/Sub-notifying budget exists — so ordering the
# binding after the budget would fix it. THAT IS FALSE, and the stack disproved it:
#
#   * `google_billing_budget.e2e_nightly` applied cleanly on 2026-08-03, WITH
#     `all_updates_rule.pubsub_topic` already set. (Budget creation does not validate topic IAM —
#     which is why 37 of 38 resources came up and only this binding did not.)
#   * Hours later, with the budget long since live, the binding was retried behind an explicit
#     `depends_on` plus a 60s propagation wait. It failed with the SAME error.
#
# So creating a notifying budget through the API does not bring the agent into being, and the wait
# was treating a permissions problem as a timing one. Nor can the agent be forced: `gcloud beta
# services identity create --service=billingbudgets.googleapis.com` returns
# SU_INTERNAL_GENERATE_SERVICE_IDENTITY — billingbudgets is not one of the services that supports
# explicit identity generation, so `google_project_service_identity` has nothing to call either.
# Google's own programmatic-notifications doc states the grant as a prerequisite and is silent on
# how the principal comes to exist.
#
# THE CONSEQUENCE. There is no OpenTofu path to this binding on a billing account that has never had
# one. Leaving it declared unconditionally means `tofu apply` can never converge — which blocks every
# UNRELATED change to this stack behind a resource that cannot be created. So it is gated, defaulting
# OFF, and the gate SHOUTS (see the check below) rather than quietly omitting a cost guard.
#
# TO TURN IT ON: grant the role once out of band — the Cloud Console's budget UI connects a topic
# through a privileged path that does not require the principal to pre-exist. Then flip
# `budget_publisher_binding_enabled = true` and `tofu import` the binding so it is managed from here.
# (We have not run the Console path ourselves; it is the remaining untried option, not a proven one.)
resource "google_pubsub_topic_iam_member" "e2e_budget_publisher" {
  count = var.budget_publisher_binding_enabled ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.e2e_budget.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budgets@system.gserviceaccount.com"

  depends_on = [google_billing_budget.e2e_nightly]
}

# The gap must never be silent. A budget whose agent cannot publish still evaluates its thresholds
# and still renders in the Console — it just never tells anyone. That is strictly worse than no
# budget at all, because it LOOKS like cover. So every plan and every apply of this stack restates
# that the alerts are undeliverable, for as long as that is true.
#
# `check` (warn) rather than a precondition (block) is deliberate and is the opposite call from
# NAMING-001. A naming overflow is a defect to be refused; this is a known, documented,
# externally-blocked gap on a stack whose OTHER 37 resources are the e2e federation plane. Blocking
# would take the nightly's whole credential path hostage to a Google API limitation.
check "budget_alerts_are_deliverable" {
  assert {
    condition     = var.budget_publisher_binding_enabled
    error_message = "COST GUARD INCOMPLETE (#1871): the budget 'alethia-e2e-nightly' evaluates thresholds but CANNOT DELIVER them — billing-budgets@system.gserviceaccount.com holds no publish rights on ${google_pubsub_topic.e2e_budget.name}, and the principal does not exist to be granted any. Cost control on the gcp nightly currently rests on teardown working. Grant the role once via the Cloud Console, then set budget_publisher_binding_enabled = true and import the binding."
  }
}

# Guard the pairing itself: the budget notifies ONE topic and we grant publish on ONE topic. If a
# future edit points them at different topics the budget keeps evaluating and the alerts silently
# stop being delivered — nothing in GCP checks that a budget's topic is writable by the agent. Same
# failure shape as #1831: a decision that reports on an emitter has to mirror what the emitter did.
check "budget_notifies_the_topic_we_granted" {
  assert {
    condition     = google_billing_budget.e2e_nightly.all_updates_rule[0].pubsub_topic == google_pubsub_topic.e2e_budget.id
    error_message = "The budget notifies ${google_billing_budget.e2e_nightly.all_updates_rule[0].pubsub_topic} but publish is granted on ${google_pubsub_topic.e2e_budget.id} — budget alerts would be evaluated and never delivered."
  }
}
