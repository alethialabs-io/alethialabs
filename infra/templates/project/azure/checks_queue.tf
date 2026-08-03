# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Service Bus queue invariants, added with ordered (session) delivery (#1812).
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

locals {
  # Queues the console asked to be ordered. `service_bus_queues` is map(any) at the root, so the key
  # is read defensively; the module's typed object is what gives it a default.
  service_bus_session_queues = [
    for k, q in var.service_bus_queues : k if try(q.requires_session, false)
  ]
}

# WARN companion to the fail-closed guard below: states the violation where a plan reader sees it.
check "service_bus_sessions_need_standard_or_premium" {
  assert {
    condition     = !var.create_service_bus || var.service_bus_sku != "Basic" || length(local.service_bus_session_queues) == 0
    error_message = "Service Bus sessions are a Standard/Premium feature and service_bus_sku is 'Basic'; ordered queues: ${join(", ", local.service_bus_session_queues)}. terraform_data.service_bus_session_sku_guard blocks apply."
  }
}

# Fail-closed apply gate. `check` blocks only WARN, so without this the Basic + sessions combination
# reaches Azure and is refused mid-apply, after the namespace already exists. The two inputs are
# independent — the SKU is a project-level choice and ordering is a per-queue switch — so nothing
# else in the template stops a user selecting both.
resource "terraform_data" "service_bus_session_sku_guard" {
  lifecycle {
    precondition {
      condition     = !var.create_service_bus || var.service_bus_sku != "Basic" || length(local.service_bus_session_queues) == 0
      error_message = "Ordered delivery on Azure needs a session-enabled Service Bus queue, and the Basic tier does not support sessions. Raise service_bus_sku to Standard or Premium, or turn ordered delivery off for: ${join(", ", local.service_bus_session_queues)}."
    }
  }
}
