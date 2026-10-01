# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Remote state from day one, in the shared AWS state bucket aws-oidc and infra/github already use
# (email-ses/bootstrap/ owns it — this stack creates no bucket). The maintainer applying this stack
# holds admin AWS credentials for the four trust stacks anyway, and those authenticate the backend
# natively: no static state key exists. Configure with `tofu init -backend-config=backend.hcl`.
terraform {
  backend "s3" {}
}
