# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 backend in the ALETHIA platform account's existing state bucket, under its own key — NOT in the
# e2e account. The backend authenticates with the default AWS credential chain (the maintainer's
# Alethia SSO session, `AWS_PROFILE=alethia-sso`), never with the management-account profile the
# provider uses. See ../README.md "Where the state lives" for why the state of the stack that
# defines the e2e account's guardrails must not live inside the e2e account.
#
#   tofu init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
