# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 backend in the ALETHIA platform account's existing state bucket, under its own key — NOT in the
# email account. The backend authenticates with the default AWS credential chain (the maintainer's
# Alethia SSO session, `AWS_PROFILE=alethia-sso`), never with the management-account profile the
# provider uses. See ../README.md "Where the state lives".
#
#   tofu init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
