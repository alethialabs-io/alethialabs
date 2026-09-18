# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #4226 — let `alethia-e2e-nightly` accept a short-lived assertion minted by the dedicated E2E
# assertion broker (apps/e2e-issuer, contract in packages/workload-identity/src/broker.ts), in
# ADDITION to the GitHub Actions OIDC trust in e2e-nightly.tf.
#
# OFF BY DEFAULT. `e2e_broker_issuer_url = null` (the committed value in terraform.tfvars) creates
# no provider and renders no trust statement, so a plan on this change alone is a no-op. Setting it
# to the broker's origin ADDS one IAM OIDC provider and one statement (`E2EBrokerAssertion`) to the
# role's trust document; the GitHub statement is untouched. Setting it back to null removes both
# and nothing else — the trust is additive and independently removable. The checks in checks.tf
# report on every plan if either half stops being true.
#
# WHAT AWS CAN PIN, and what it cannot. For a generic (non-GitHub) OIDC provider, IAM exposes only
# `<issuer>:aud` and `<issuer>:sub` (plus `amr`) as condition keys, so this trust pins:
#
#   issuer    — the provider URL, via the Federated principal (a token from any other issuer is
#               never evaluated against this statement)
#   audience  — `sts.amazonaws.com`, read from WORKLOAD_PROVIDER_AUDIENCES below
#   subject   — `alethia-connector`, read from WORKLOAD_SUBJECT below
#
# The run binding (repository, workflow_ref, run_id, run_attempt) is carried in the assertion as
# custom claims, but IAM cannot condition on custom claims from a generic provider. It is enforced
# by the BROKER before it signs (ALLOWED_REPOSITORIES, ALLOWED_WORKFLOW_REFS, the GitHub-token
# cross-check and the replay guard in apps/e2e-issuer/src/worker.ts), not here.
#
# LIFETIME. IAM has no trust-side knob for the incoming token's lifetime; it only refuses an expired
# one. The assertion lifetime is capped by the broker at 60–600s (MIN_/MAX_ASSERTION_TTL_SECONDS in
# broker.ts, enforced by brokerAssertionRequestSchema). The session it buys is capped by the role's
# max_session_duration (7200s, e2e-nightly.tf) and whatever DurationSeconds the caller requests.
#
# Applied by the maintainer only (invariant 4); see docs/testing/e2e-federation-apply-runbook.md.

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
  # the account id comes from data.aws_caller_identity, which is read at plan. The check
  # `e2e_broker_provider_arn_matches` in checks.tf compares this string with the resource's real
  # `arn` once it is known (at apply), so the two cannot drift silently.
  broker_provider_arn = local.broker_enabled ? "arn:aws:iam::${local.account_id}:oidc-provider/${local.broker_issuer_host}" : ""
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
  tags           = merge(local.tags, { purpose = "e2e-assertion-broker" })
}
