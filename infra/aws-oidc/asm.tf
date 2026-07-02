# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The single production secret vault. This module creates only the CONTAINER — values
# are written out of band (scripts/bootstrap-secrets.sh generates internals + merges
# externals; CI merges TUNNEL_TOKEN/DEPLOY_HOST). No secret_version here, so no secret
# material ever lands in OpenTofu state.

resource "aws_secretsmanager_secret" "prod_env" {
  name        = var.prod_env_secret_name
  description = "Alethia prod runtime + infra secrets (one JSON blob). Read by CI via OIDC; the box never sees AWS creds."
  tags        = local.tags
}
