# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant reports on the issuer's origin.
#
# A `check` block WARNS; it does not fail the plan or the apply. The properties that must be
# UN-APPLIABLE are enforced harder, and not here: the hostname's shape and its exclusion from the
# Route53-delegated e2e.alethialabs.io are variable `validation`s (variables.tf), and "inside the zone"
# plus "a bare origin" are `precondition`s on the custom domain (main.tf). These checks restate the
# shape so a plan says it in one place, and add the two things only a check can say: facts read back
# from Cloudflare after apply, and whether the issuer is actually answering at this host.

check "issuer_url_is_a_bare_origin_in_the_zone" {
  assert {
    condition = alltrue([
      can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", local.issuer_url)),
      !endswith(local.issuer_url, "/"),
      endswith(var.hostname, ".${var.zone_name}"),
      var.hostname != "e2e.${var.zone_name}",
      !endswith(var.hostname, ".e2e.${var.zone_name}"),
    ])
    error_message = "the issuer must be https://<host> with no path, port or trailing slash, the host inside ${var.zone_name} and outside the Route53-delegated e2e.${var.zone_name} — got ${local.issuer_url}."
  }
}

check "zone_is_active_in_the_expected_account" {
  assert {
    condition = alltrue([
      data.cloudflare_zone.this.name == var.zone_name,
      data.cloudflare_zone.this.status == "active",
      data.cloudflare_zone.this.account.id == var.cloudflare_account_id,
    ])
    error_message = "the ${var.zone_name} zone must be active in account ${var.cloudflare_account_id} — got name=${coalesce(data.cloudflare_zone.this.name, "<none>")}, status=${coalesce(data.cloudflare_zone.this.status, "<none>")}."
  }
}

check "custom_domain_binds_the_declared_worker" {
  assert {
    condition = alltrue([
      cloudflare_workers_custom_domain.issuer.hostname == var.hostname,
      cloudflare_workers_custom_domain.issuer.service == local.worker_name,
      cloudflare_workers_custom_domain.issuer.zone_id == data.cloudflare_zone.this.zone_id,
    ])
    error_message = "the custom domain must bind ${var.hostname} to the Worker ${local.worker_name} (apps/e2e-issuer/wrangler.jsonc) in zone ${var.zone_name}."
  }
}

check "caa_names_exactly_the_cloudflare_cas" {
  assert {
    condition = alltrue([
      toset([for r in cloudflare_dns_record.caa : r.data.value]) == local.caa_issuers,
      alltrue([for r in cloudflare_dns_record.caa : r.name == var.hostname && r.data.tag == "issue" && r.data.flags == 0]),
    ])
    error_message = "the CAA set on ${var.hostname} must be exactly `0 issue` for ${join(", ", sort(local.caa_issuers))}."
  }
}

# The one check that measures the world rather than the config. It reads discovery at the host this
# stack binds and asserts the Worker answers there AS this issuer. It is expected to WARN in exactly
# one window of the runbook — after this apply binds the host and before the Worker is redeployed
# with ISSUER_URL = this origin — where the Worker answers 503 `issuer_origin_mismatch`. That is
# proof the host routes to the Worker; the redeploy closes it. A DNS or TLS failure inside a scoped
# data source is reported as a warning here, never as a plan error, so an unbound host cannot block
# the apply that binds it.
check "issuer_serves_discovery_at_this_origin" {
  data "http" "discovery" {
    url = "${local.issuer_url}/.well-known/openid-configuration"
    request_headers = {
      Accept = "application/json"
    }
  }

  assert {
    condition = (
      data.http.discovery.status_code == 200
      && try(jsondecode(data.http.discovery.response_body).issuer, "") == local.issuer_url
      && try(jsondecode(data.http.discovery.response_body).jwks_uri, "") == "${local.issuer_url}/.well-known/jwks.json"
    )
    error_message = "${local.issuer_url}/.well-known/openid-configuration must answer 200 with issuer = ${local.issuer_url} and jwks_uri under it. Before the Worker is redeployed with ISSUER_URL = ${local.issuer_url} this is expected (README.md, step 4)."
  }
}
