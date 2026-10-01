# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the issuer origin plans what it claims, and that every guard on it FIRES — a guard nobody
# has seen fail is indistinguishable from no guard.
#
# Providers are mocked, so this needs no credentials and makes no network call (the discovery probe
# in checks.tf is a mocked `http` read). .github/workflows/infra-e2e-issuer.yml runs it on every PR
# that touches this stack; locally: `tofu init -backend=false && tofu test` from this directory.

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = {
      zone_id = "0123456789abcdef0123456789abcdef"
      name    = "alethialabs.io"
      status  = "active"
      account = { id = "fedcba9876543210fedcba9876543210", name = "alethia" }
    }
  }
}

mock_provider "http" {
  mock_data "http" {
    defaults = {
      status_code   = 200
      response_body = "{\"issuer\":\"https://e2e-issuer.alethialabs.io\",\"jwks_uri\":\"https://e2e-issuer.alethialabs.io/.well-known/jwks.json\"}"
    }
  }
}

# A scoped data source inside a `check` has no address `override_data` can target, so the two runs that
# need a different discovery answer swap in one of these aliased mocks instead.
mock_provider "http" {
  alias = "origin_mismatch"
  mock_data "http" {
    defaults = {
      status_code   = 503
      response_body = "{\"error\":\"issuer_origin_mismatch\"}"
    }
  }
}

mock_provider "http" {
  alias = "workers_dev"
  mock_data "http" {
    defaults = {
      status_code   = 200
      response_body = "{\"issuer\":\"https://alethia-e2e-issuer.example.workers.dev\",\"jwks_uri\":\"https://alethia-e2e-issuer.example.workers.dev/.well-known/jwks.json\"}"
    }
  }
}

# terraform.tfvars supplies zone_name and hostname; only the uncommitted input is set here.
variables {
  cloudflare_account_id = "fedcba9876543210fedcba9876543210"
}

# The committed posture: e2e-issuer.alethialabs.io bound to the Worker wrangler.jsonc names, with the
# four-CA CAA set, and no check reporting.
run "committed_posture_binds_the_worker_and_pins_caa" {
  command = plan

  assert {
    condition = alltrue([
      cloudflare_workers_custom_domain.issuer.hostname == "e2e-issuer.alethialabs.io",
      # A literal, not local.worker_name: this fails if the wrangler regex ever extracts the wrong
      # "name" (the Durable Object binding also has one) instead of passing by construction.
      cloudflare_workers_custom_domain.issuer.service == "alethia-e2e-issuer",
      cloudflare_workers_custom_domain.issuer.zone_id == "0123456789abcdef0123456789abcdef",
      cloudflare_workers_custom_domain.issuer.account_id == "fedcba9876543210fedcba9876543210",
    ])
    error_message = "the custom domain must bind e2e-issuer.alethialabs.io to alethia-e2e-issuer in the looked-up zone."
  }
  assert {
    condition     = output.issuer_url == "https://e2e-issuer.alethialabs.io"
    error_message = "the issuer URL must be exactly https://e2e-issuer.alethialabs.io — no path, no trailing slash."
  }
  assert {
    condition = alltrue([
      length(cloudflare_dns_record.caa) == 4,
      toset([for r in cloudflare_dns_record.caa : r.data.value]) == toset(["pki.goog", "letsencrypt.org", "ssl.com", "sectigo.com"]),
      alltrue([for r in cloudflare_dns_record.caa : r.type == "CAA" && r.name == "e2e-issuer.alethialabs.io" && r.data.tag == "issue"]),
    ])
    error_message = "the host must carry exactly four `issue` CAA records — the CAs Cloudflare documents it may use."
  }
}

run "a_host_in_the_route53_subzone_is_refused" {
  command = plan
  variables {
    hostname = "issuer.e2e.alethialabs.io"
  }
  expect_failures = [var.hostname]
}

run "the_route53_subzone_apex_is_refused" {
  command = plan
  variables {
    hostname = "e2e.alethialabs.io"
  }
  expect_failures = [var.hostname]
}

run "a_url_with_a_scheme_or_path_is_refused" {
  command = plan
  variables {
    hostname = "https://e2e-issuer.alethialabs.io/"
  }
  expect_failures = [var.hostname]
}

run "a_trailing_dot_is_refused" {
  command = plan
  variables {
    hostname = "e2e-issuer.alethialabs.io."
  }
  expect_failures = [var.hostname]
}

# Well-formed and outside the subzone, but not in the zone at all: only the precondition can see it,
# because it compares two variables.
run "a_host_outside_the_zone_is_unappliable" {
  command = plan
  variables {
    hostname = "e2e-issuer.example.com"
  }
  # The check restating the shape reports it too, and the discovery probe (mocked to answer as the
  # committed origin) disagrees with the new one. The precondition is the one that makes it un-appliable.
  expect_failures = [
    cloudflare_workers_custom_domain.issuer,
    check.issuer_url_is_a_bare_origin_in_the_zone,
    check.issuer_serves_discovery_at_this_origin,
  ]
}

run "another_zone_is_refused" {
  command = plan
  variables {
    zone_name = "example.com"
    hostname  = "e2e-issuer.example.com"
  }
  # Discovery still answers as the committed origin, so that check reports as well; the validation
  # is what refuses it.
  expect_failures = [
    var.zone_name,
    check.issuer_serves_discovery_at_this_origin,
  ]
}

run "a_malformed_account_id_is_refused" {
  command = plan
  variables {
    cloudflare_account_id = "not-an-account"
  }
  expect_failures = [var.cloudflare_account_id]
}

# The zone the lookup returned is in a different account: reported.
run "a_zone_in_another_account_is_reported" {
  command = plan
  override_data {
    target = data.cloudflare_zone.this
    values = {
      zone_id = "0123456789abcdef0123456789abcdef"
      name    = "alethialabs.io"
      status  = "active"
      account = { id = "11111111111111111111111111111111", name = "someone-else" }
    }
  }
  expect_failures = [check.zone_is_active_in_the_expected_account]
}

# The window between binding the host and redeploying the Worker: the Worker answers, but as a
# different issuer. The check must say so rather than pass.
run "a_worker_answering_as_another_issuer_is_reported" {
  command = plan
  providers = {
    cloudflare = cloudflare
    http       = http.origin_mismatch
  }
  expect_failures = [check.issuer_serves_discovery_at_this_origin]
}

run "discovery_naming_the_workers_dev_origin_is_reported" {
  command = plan
  providers = {
    cloudflare = cloudflare
    http       = http.workers_dev
  }
  expect_failures = [check.issuer_serves_discovery_at_this_origin]
}
