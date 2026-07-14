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

# Let the Cloud Billing budgets managed service agent publish budget notifications to the topic.
# Address per Google's programmatic-budget-notifications docs; scoped to THIS topic only.
resource "google_pubsub_topic_iam_member" "e2e_budget_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.e2e_budget.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budgets@system.gserviceaccount.com"
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
