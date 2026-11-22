# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 backend in the ALETHIA platform account's existing state bucket, under a new key
# (`backup-account/terraform.tfstate`) — the same bucket and the same `alethia-sso` authentication as
# infra/email-ses-account and infra/aws-e2e. The state holds no secret: the writer's access key and
# the drill's age identity are both created OUTSIDE this stack (README.md "No secret in the state").
#
#   AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
