# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# This stack's state lives in the bucket this stack creates. That is not circular in practice: the
# FIRST apply runs `tofu init -backend=false` (local state), and a single documented
# `tofu init -backend-config=backend.hcl -migrate-state` afterwards moves it in. Every apply after
# that is plain remote state. Runbook: docs/testing/e2e-state-migration.md.
#
# The GCS backend locks natively (object generation preconditions) — no separate lock table.
terraform {
  backend "gcs" {}
}
