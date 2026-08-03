# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# OSS backend in the same Alibaba account as the RAM entities this stack creates — the Alibaba
# analogue of infra/aws-oidc's S3 backend. The admin identity that applies this bootstrap
# authenticates the backend natively (ALICLOUD_ACCESS_KEY / an `aliyun` profile / a RAM session),
# so there are no separate state credentials.
#
# Partial config on purpose: the bucket is supplied at init time rather than hardcoded.
#   tofu init -backend-config=backend.hcl
#
# The bucket itself comes from infra/alibaba-e2e/bootstrap/, which is applied first — a stack cannot
# create the container its own state lives in. Migration runbook:
# docs/testing/e2e-state-migration.md.
#
# KNOWN GAP — no state locking. The OSS backend locks only when it is also given a TableStore
# instance + table, and this repo deliberately does not stand one up for a stack exactly one
# maintainer ever applies by hand. Stated rather than assumed: if a second operator is ever given
# these credentials, add `tablestore_endpoint` + `tablestore_table` to backend.hcl (and an
# `alicloud_ots_instance` + `alicloud_ots_table` to bootstrap/) before they run anything. Note the
# 16-character cap on a TableStore instance name if you do (#1884).
terraform {
  backend "oss" {}
}
