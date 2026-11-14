# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #4226 — the E2E assertion broker trust, re-homed with the role. Byte-for-byte the contract of
# infra/aws-oidc/e2e-broker.tf (read that file's header for what IAM can and cannot pin, and for the
# lifetime argument); the only difference is the account the provider is created in. The broker
# itself (apps/e2e-issuer) holds no AWS account or role allowlist — the caller names the role
# (E2E_AWS_ROLE_ARN), so pointing that variable at this account's role is the whole switch.
#
# Gated on the issuer: the committed terraform.tfvars sets e2e_broker_issuer_url, so an apply creates
# one IAM OIDC provider and one trust statement; null creates neither.

locals {
  # The ONE copy of the broker contract is TypeScript. Read it rather than restate it: a second
  # hand-typed copy of these audiences already failed the nightly once with `audience_not_allowed`
  # and no repo diff to explain it (#4236). If the file moves or the shape changes, `regex` fails
  # and the plan errors — loudly, before anything is applied.
  broker_contract  = file("${path.module}/../../packages/workload-identity/src/broker.ts")
  broker_audiences = regex("WORKLOAD_PROVIDER_AUDIENCES[^=]*=\\s*\\{([^}]*)\\}", local.broker_contract)[0]
  broker_audience  = regex("\\baws:\\s*\"([^\"]+)\"", local.broker_audiences)[0]
  broker_subject   = regex("WORKLOAD_SUBJECT\\s*=\\s*\"([^\"]+)\"", local.broker_contract)[0]

  broker_enabled = var.e2e_broker_issuer_url != null

  # IAM names a generic provider's condition keys by its URL without the scheme. The variable's
  # validation admits only a bare https origin, so this is a hostname.
  broker_issuer_host = local.broker_enabled ? trimprefix(var.e2e_broker_issuer_url, "https://") : ""

  # The provider's ARN, BUILT from plan-time values rather than read off the resource. `arn` is
  # computed, so a trust document that referenced aws_iam_openid_connect_provider.e2e_broker[0].arn
  # would plan as `(known after apply)` on the very plan that enables the broker: the maintainer
  # could not read the rendered trust, and every check in checks.tf that reads the trust JSON would
  # evaluate to unknown. IAM names a generic OIDC provider `oidc-provider/<url without scheme>`, and
  # the account id is var.e2e_account_id, which the provider's allowed_account_ids pins. The check
  # `e2e_broker_provider_arn_matches` in checks.tf compares this string with the resource's real
  # `arn` once it is known (at apply), so the two cannot drift silently.
  broker_provider_arn = local.broker_enabled ? "arn:aws:iam::${var.e2e_account_id}:oidc-provider/${local.broker_issuer_host}" : ""
}

# The broker's IAM OIDC provider. No thumbprint_list: it is optional from provider 5.81 (measured —
# 5.80.0's schema marks it required, 5.81.0's does not; versions.tf pins ~> 5.81 for that), and IAM
# verifies a JWKS endpoint whose certificate chains to a CA in its trusted-root library without one.
# The Worker is served from Cloudflare's edge, which presents publicly issued certificates. If the
# origin ever moves behind a private CA, IAM falls back to thumbprints and one must be added here.
resource "aws_iam_openid_connect_provider" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  url            = var.e2e_broker_issuer_url
  client_id_list = [local.broker_audience]
  tags           = { purpose = "e2e-assertion-broker" }
}
