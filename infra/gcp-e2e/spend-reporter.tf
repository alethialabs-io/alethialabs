# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ── The weekly spend report's GCP identity ─────────────────────────────────────────────────────
# A service account that can READ: the billing account (open or closed, and its budgets), and the
# budget notifications this stack's budget already publishes to `alethia-e2e-nightly-budget-alerts`
# (e2e-budget.tf). The Budget API holds a budget's AMOUNT, never its spend — the spend is only ever
# in those notifications (`costAmount`, month to date), so a pull subscription is how the report
# gets a number at all.
#
# ⚠️ THE TRUST IS NOT CHANGED. This file adds a binding on a NEW service account and touches neither
# the Workload Identity pool nor its provider. The provider's attribute condition (e2e-nightly.tf)
# already admits a token from this repo whose `ref` is refs/heads/main — which the spend-report job,
# on main, presents — and the binding below narrows that to ONE subject, the spend-report
# environment's, with `principal://…/subject/…` rather than the repo-wide principalSet the e2e SA
# uses. A gcp-e2e apply has dropped the dispatch trust before (terraform.tfvars, #3108); nothing here
# depends on, or alters, `e2e_github_environment`.
#
# Apply it with -target (scripts/spend-report/README.md): this stack's committed tfvars also carry
# the e2e broker trust, which an untargeted apply would create as well.

locals {
  spend_reporter_subject = "repo:${var.github_repo}:environment:${var.spend_reporter_github_environment}"
  # EXACTLY one subject — never the principalSet://…/attribute.repository/<repo> form, which would
  # admit every workflow on main.
  spend_reporter_principal = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.e2e.name}/subject/${local.spend_reporter_subject}"
}

resource "google_service_account" "spend_reporter" {
  account_id   = "alethia-spend-reporter"
  display_name = "Alethia weekly spend report"
  description  = "Federated (WIF) by spend-report.yml only. Billing account viewer + subscriber on the e2e budget-alerts subscription. Reads, never writes. See infra/gcp-e2e/spend-reporter.tf."

  depends_on = [google_project_service.apis]
}

resource "google_service_account_iam_member" "spend_reporter_wif" {
  service_account_id = google_service_account.spend_reporter.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.spend_reporter_principal
}

# Billing Account Viewer: `billing.accounts.get` (is it open?) and `billing.budgets.get/list`. It also
# reads the account's cost views, which is the point of the role. No write of any kind.
resource "google_billing_account_iam_member" "spend_reporter_viewer" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.viewer"
  member             = "serviceAccount:${google_service_account.spend_reporter.email}"
}

# The report's own pull subscription. Messages are NOT acknowledged by the report — they age out
# at the retention below, so each week's pull sees the last seven days of notifications and can
# estimate the 7-day spend from the earliest and latest `costAmount`. Never expires: a weekly
# reader is "inactive" for six days at a time, and the 31-day default would delete it after a month
# of missed runs, silently.
resource "google_pubsub_subscription" "spend_reporter" {
  name    = "alethia-spend-reporter"
  project = var.project_id
  topic   = google_pubsub_topic.e2e_budget.id

  ack_deadline_seconds       = 600
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription_iam_member" "spend_reporter_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.spend_reporter.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.spend_reporter.email}"
}
