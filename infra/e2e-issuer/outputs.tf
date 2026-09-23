# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "issuer_url" {
  description = "The issuer origin — the value for the E2E_ISSUER_URL repository variable and for `e2e_broker_issuer_url` in infra/{aws-oidc,gcp-e2e,azure-e2e,alibaba-e2e}/terraform.tfvars. `node scripts/ci/check-e2e-issuer-health.mjs --static` fails when any of those disagree."
  value       = local.issuer_url
}

output "worker_name" {
  description = "The Worker the host is bound to, read from apps/e2e-issuer/wrangler.jsonc."
  value       = local.worker_name
}

output "zone_id" {
  description = "The alethialabs.io zone id, looked up by name within the account."
  value       = data.cloudflare_zone.this.zone_id
}

output "custom_domain_id" {
  description = "The Workers Custom Domain binding."
  value       = cloudflare_workers_custom_domain.issuer.id
}

output "certificate_id" {
  description = "The Advanced Certificate Cloudflare generated for the host. It is NOT deleted when the custom domain is (Cloudflare docs) — remove it by hand after a teardown."
  value       = cloudflare_workers_custom_domain.issuer.cert_id
}

output "caa_issuers" {
  description = "The CAs the host's CAA set permits."
  value       = sort(local.caa_issuers)
}
