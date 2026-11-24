# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# S3 backend in the ALETHIA platform account's existing state bucket, under its own key
# (`books-archive/terraform.tfstate`) — the same bucket and the same `alethia-sso` authentication as
# infra/backup-account. The state holds no secret: the console writer's access key is minted OUTSIDE
# this stack (ops/mint-console-writer-key.sh) and the connectors secret is a shell with no value.
#
#   AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
terraform {
  backend "s3" {}
}
