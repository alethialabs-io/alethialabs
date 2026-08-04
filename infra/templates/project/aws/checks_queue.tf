# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# SQS queue-naming invariants, added with ordered (FIFO) delivery (#1812).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

locals {
  # The names modules/sqs-sns builds, restated here because a `count`-gated module cannot decide a
  # plan-time gate for the plan that decides whether to call it. Kept in ONE place per side and
  # asserted against the module's real planned names in checks_queue_naming.tftest.hcl, so the two
  # cannot drift apart silently.
  sqs_queue_names = {
    for k, q in var.sqs_queues : k => "${k}_${var.environment}${try(q.fifo_queue, false) ? ".fifo" : ""}"
  }
  sqs_dlq_names = {
    for k, q in var.sqs_queues : k => "${k}${try(q.fifo_queue, false) ? ".fifo" : ""}"
    if try(q.dlq_enable, false)
  }

  # SQS caps a queue name at 80 characters, and the cap counts the `.fifo` suffix — so turning on
  # ordered delivery costs a queue 5 characters of its budget. A name that overflows is rejected by
  # the API at CREATE time, i.e. mid-apply, after the rest of the project already exists.
  sqs_overlong_names = [
    for n in concat(values(local.sqs_queue_names), values(local.sqs_dlq_names)) : n if length(n) > 80
  ]
}

# WARN companion to the fail-closed guard below: states the violation in the plan output, where a
# reader sees it, rather than only in the error that stops the apply.
check "sqs_queue_names_within_limit" {
  assert {
    condition     = !var.provision_sqs || length(local.sqs_overlong_names) == 0
    error_message = "SQS caps a queue name at 80 characters including the '.fifo' suffix; over-long: ${join(", ", local.sqs_overlong_names)}. terraform_data.sqs_naming_guard blocks apply."
  }
}

# Fail-closed apply gate. `check` blocks only WARN, so an over-long name would otherwise reach the
# SQS API and fail mid-provision — the same shape as the NAMING-001 break in #1716. Ordered delivery
# is what makes this reachable: an existing 78-character queue name is legal until the switch is
# flipped and the suffix pushes it to 83.
resource "terraform_data" "sqs_naming_guard" {
  lifecycle {
    precondition {
      condition     = !var.provision_sqs || length(local.sqs_overlong_names) == 0
      error_message = "SQS rejects a queue name longer than 80 characters, and the '.fifo' suffix that ordered delivery adds counts toward it. Shorten the queue name or the environment: ${join(", ", local.sqs_overlong_names)}."
    }
  }
}
