# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 backend in the ALETHIA platform account's existing state bucket, under a new key
# (`aws-e2e/terraform.tfstate`) — deliberately NOT in the e2e account this stack configures. The
# backend authenticates with the default credential chain (the maintainer's Alethia SSO session);
# the provider then assumes `alethia-e2e-admin` in the e2e account (provider.tf). Why the state
# stays out of the e2e account: README.md "Where the state lives".
#
#   AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
