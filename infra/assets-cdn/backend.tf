# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Remote state from day one, in the shared AWS state bucket aws-oidc, infra/github and infra/e2e-issuer
# already use (email-ses/bootstrap/ owns it — this stack creates no bucket). The applying maintainer's
# own AWS credentials authenticate the backend natively: no static state key exists. The state holds
# no secret — the Cloudflare token is read from the environment by the provider and is never a
# variable. Configure with `tofu init -backend-config=backend.hcl`.
terraform {
  backend "s3" {}
}
