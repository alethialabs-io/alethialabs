# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# GCS backend in the same DEDICATED e2e project as the identity this stack creates — the GCP
# analogue of infra/aws-oidc's S3 backend, and the reason that one has never depended on a single
# laptop. The admin identity that applies this bootstrap authenticates the backend natively
# (Application Default Credentials), so there are no static state keys.
#
# Partial config on purpose: the bucket is supplied at init time rather than hardcoded.
#   tofu init -backend-config=backend.hcl
#
# The bucket itself comes from infra/gcp-e2e/bootstrap/, which is applied first — a stack cannot
# create the container its own state lives in. Migration runbook:
# docs/testing/e2e-state-migration.md.
terraform {
  backend "gcs" {}
}
