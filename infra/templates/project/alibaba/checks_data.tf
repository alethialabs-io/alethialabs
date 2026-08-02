# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ApsaraDB RDS data-tier invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.

check "rds_engine_present" {
  assert {
    condition     = !var.create_rds || length(trimspace(var.rds_engine)) > 0
    error_message = "When create_rds is true, rds_engine must be a non-empty string (e.g. PostgreSQL)."
  }
}
