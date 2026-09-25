# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #4226 — let the `alethia-e2e-nightly` RAM role accept a short-lived assertion minted by the
# dedicated E2E assertion broker (apps/e2e-issuer, contract in packages/workload-identity/src/
# broker.ts), in ADDITION to the GitHub Actions OIDC trust in oidc.tf / roles.tf.
#
# GATED ON THE ISSUER, NOT OFF. The committed terraform.tfvars sets `e2e_broker_issuer_url` to
# https://e2e-issuer.alethialabs.io (#5004), and the broker trust is created whenever it is non-null
# — so any plan or apply of this stack proposes one RAM OIDC provider and one appended trust
# statement. Apply only after the issuer serves at that origin (docs/testing/e2e-state-migration.md,
# infra/e2e-issuer/README.md). To plan without the broker, pass
# `-var-file=<(printf 'e2e_broker_issuer_url = null\n')` — a plain `-var e2e_broker_issuer_url=null`
# passes the string "null", not null.
# Setting it creates one RAM OIDC provider and appends one statement to the role's trust document;
# setting it back to null removes exactly those two. The GitHub provider and Statement[0] are never
# touched.
#
# WHAT RAM CAN PIN. RAM's OIDC condition keys are `oidc:iss`, `oidc:aud` and `oidc:sub`, so the
# statement pins, with StringEquals:
#
#   issuer    — oidc:iss = var.e2e_broker_issuer_url (and the Federated principal is this provider)
#   audience  — oidc:aud = `sts.aliyuncs.com`, read from WORKLOAD_PROVIDER_AUDIENCES
#   subject   — oidc:sub = `alethia-connector`, read from WORKLOAD_SUBJECT
#
# The run binding (repository, workflow_ref, run_id, run_attempt) rides in custom claims RAM does not
# read; the BROKER enforces it before it signs (ALLOWED_REPOSITORIES, ALLOWED_WORKFLOW_REFS, the
# GitHub-token cross-check and the replay guard in apps/e2e-issuer/src/worker.ts).
#
# TLS PIN (maintainer ruling 2026-09-23). RAM pins the SHA-1 fingerprints of the CA certificates the
# issuer's host serves, at most five. This used to pin whatever chain `tofu plan` happened to see —
# trust on first use, at plan time, and silently wrong the day Cloudflare re-issued the host's
# certificate from another CA or intermediate (it may: its CAA injection lists four CAs, and GTS and
# Let's Encrypt each rotate between several intermediates — infra/e2e-issuer/main.tf). Now the set is
# the REVIEWED one committed in infra/e2e-issuer/tls-ca-pin.json, which the scheduled health check
# (.github/workflows/e2e-issuer-health.yml) compares with the live chain every day. The live read below
# is kept, as a precondition: this refuses to write a pin that does not cover the chain being served
# right now, rather than write one RAM would refuse.
#
# LIFETIME. RAM is the one cloud of the four with a trust-side knob: an OIDC provider's
# `issuance_limit_time` rejects a token whose `iat` is older than that many hours. Alibaba's
# CreateOIDCProvider API documents the range as 1–168 (not measured here), so it is set to 1 — the
# narrowest RAM supports. The effective cap is still the broker's 60–600s
# (MIN_/MAX_ASSERTION_TTL_SECONDS, enforced by brokerAssertionRequestSchema), since RAM also refuses
# an expired token.
#
# Applied by the maintainer only; see docs/testing/e2e-federation-apply-runbook.md.

locals {
  # The ONE copy of the broker contract is TypeScript. Read it rather than restate it (#4236: a
  # hand-typed second copy of these audiences failed the nightly with no repo diff to explain it).
  # A moved file or a changed shape makes `regex` fail and the plan error before anything applies.
  broker_contract  = file("${path.module}/../../packages/workload-identity/src/broker.ts")
  broker_audiences = regex("WORKLOAD_PROVIDER_AUDIENCES[^=]*=\\s*\\{([^}]*)\\}", local.broker_contract)[0]
  broker_audience  = regex("\\balibaba:\\s*\"([^\"]+)\"", local.broker_audiences)[0]
  broker_subject   = regex("WORKLOAD_SUBJECT\\s*=\\s*\"([^\"]+)\"", local.broker_contract)[0]

  broker_enabled = var.e2e_broker_issuer_url != null

  # The reviewed pin (one copy, shared with the health check). Read even while disabled so a malformed
  # file fails every plan, not only the enabling one.
  broker_tls_pin      = jsondecode(file("${path.module}/${var.broker_tls_pin_path}"))
  broker_fingerprints = [for f in local.broker_tls_pin.fingerprints : lower(f.sha1)]

  # What the host serves right now — CA certificates only, never the leaf. Compared, never pinned.
  broker_served_ca_fingerprints = local.broker_enabled ? [
    for c in data.tls_certificate.e2e_broker[0].certificates : lower(c.sha1_fingerprint) if c.is_ca
  ] : []

  # The provider's ARN, BUILT from plan-time values rather than read off the resource. `arn` is
  # computed-only in the alicloud schema, so a statement that referenced
  # alicloud_ims_oidc_provider.e2e_broker[0].arn would make the whole assume_role_policy_document
  # `(known after apply)` on the very plan that enables the broker — the maintainer could not read
  # the trust being added, and every check reading local.trust_document would be unknown. RAM names
  # an OIDC provider `acs:ram::<account>:oidc-provider/<name>`; the account comes from
  # data.alicloud_caller_identity, which is read at plan. The check
  # `e2e_broker_provider_arn_matches` (checks.tf) compares this with the resource's real `arn` once
  # it is known, and alicloud_ram_role.e2e depends_on the provider for ordering.
  broker_provider_arn = "acs:ram::${data.alicloud_caller_identity.current.account_id}:oidc-provider/${var.broker_oidc_provider_name}"

  broker_trust_statements = local.broker_enabled ? [{
    Effect    = "Allow"
    Action    = "sts:AssumeRole"
    Principal = { Federated = [local.broker_provider_arn] }
    Condition = {
      StringEquals = {
        "oidc:iss" = var.e2e_broker_issuer_url
        "oidc:aud" = local.broker_audience
        "oidc:sub" = [local.broker_subject]
      }
    }
  }] : []
}

# The served chain, read only to check it against the committed pin (above) — never pinned directly.
# Read only while enabled, so an unset issuer makes no network call at plan. While the issuer host
# does not answer at all, this read fails the plan: the trust must not be applied before the issuer
# serves (infra/e2e-issuer/README.md orders the steps).
data "tls_certificate" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0
  url   = var.e2e_broker_issuer_url
}

resource "alicloud_ims_oidc_provider" "e2e_broker" {
  count = local.broker_enabled ? 1 : 0

  oidc_provider_name  = var.broker_oidc_provider_name
  issuer_url          = var.e2e_broker_issuer_url
  client_ids          = [local.broker_audience]
  fingerprints        = local.broker_fingerprints
  issuance_limit_time = 1
  description         = "Trust the E2E assertion broker (apps/e2e-issuer) for the e2e-nightly RAM role (#4226)."

  lifecycle {
    # Un-appliable, not merely reported: a wrong pin here is a trust RAM refuses at the nightly's
    # federation, far from the plan that wrote it.
    precondition {
      condition     = local.broker_tls_pin.issuer_url == var.e2e_broker_issuer_url
      error_message = "${var.broker_tls_pin_path} pins ${local.broker_tls_pin.issuer_url}, but e2e_broker_issuer_url is ${coalesce(var.e2e_broker_issuer_url, "<unset>")}."
    }
    precondition {
      condition     = length(local.broker_fingerprints) >= 1 && length(local.broker_fingerprints) <= 5
      error_message = "${var.broker_tls_pin_path} must pin 1–5 CA fingerprints (RAM's maximum is 5); it pins ${length(local.broker_fingerprints)}. Populate it with `node scripts/ci/check-e2e-issuer-health.mjs --print-pin --expected-url ${coalesce(var.e2e_broker_issuer_url, "<url>")} --out infra/e2e-issuer/tls-ca-pin.json` in a reviewed PR."
    }
    precondition {
      condition     = length(local.broker_served_ca_fingerprints) > 0 && alltrue([for fp in local.broker_served_ca_fingerprints : contains(local.broker_fingerprints, fp)])
      error_message = "the issuer serves CA certificate(s) ${jsonencode(local.broker_served_ca_fingerprints)}, and not all are in ${var.broker_tls_pin_path} (${jsonencode(local.broker_fingerprints)}). Add them with `--print-pin --out infra/e2e-issuer/tls-ca-pin.json`, merge, then apply."
    }
  }
}
