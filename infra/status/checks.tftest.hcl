# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the status stack plans what it claims, and that its guards FIRE — a guard nobody has seen
# fail is indistinguishable from no guard. Providers are mocked: no credentials, no network.
# .github/workflows/infra-status.yml runs it on every PR touching this stack (via iac-checks); locally:
# `tofu init -backend=false && tofu test` from this directory.

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = {
      zone_id = "0123456789abcdef0123456789abcdef"
      name    = "alethialabs.io"
      status  = "active"
      account = { id = "fedcba9876543210fedcba9876543210", name = "alethia" }
    }
  }
  mock_resource "cloudflare_d1_database" {
    defaults = { id = "11111111-2222-3333-4444-555555555555" }
  }
  mock_resource "cloudflare_workers_kv_namespace" {
    defaults = { id = "66666666777777778888888899999999" }
  }
}

# terraform.tfvars supplies zone_name and hostname; only the uncommitted inputs are set here.
variables {
  cloudflare_account_id = "fedcba9876543210fedcba9876543210"
  status_probe_token    = "0000000000000000000000000000000000000000000000000000000000000000"
  worker_bundle_path    = "tests/fixture-worker.js"
}

run "binds_the_worker_to_its_stores_its_secret_and_its_host" {
  command = plan

  assert {
    condition     = cloudflare_workers_route.status.pattern == "status.alethialabs.io/*"
    error_message = "the route must cover every path on status.alethialabs.io"
  }
  assert {
    condition     = cloudflare_dns_record.status.proxied == true && cloudflare_dns_record.status.content == "192.0.2.1"
    error_message = "the record must be proxied (a Workers route binds only to a proxied host) and point at TEST-NET-1"
  }
  assert {
    condition     = toset([for b in cloudflare_workers_script.status.bindings : "${b.name}:${b.type}"]) == toset(["DB:d1", "SNAPSHOT:kv_namespace", "STATUS_PROBE_TOKEN:secret_text"])
    error_message = "the Worker needs exactly its D1, KV and probe-secret bindings, under the names src/worker.ts reads"
  }
  assert {
    condition     = cloudflare_workers_cron_trigger.status.schedules[0].cron == "* * * * *"
    error_message = "the probe cycle runs every minute"
  }
  assert {
    condition     = output.status_url == "https://status.alethialabs.io"
    error_message = "status_url must match SITE in packages/status/src/render.ts"
  }
}

run "refuses_to_plan_without_a_built_bundle" {
  command = plan
  variables {
    worker_bundle_path = "tests/no-such-bundle.js"
  }
  expect_failures = [cloudflare_workers_script.status]
}

run "refuses_a_short_probe_token" {
  command = plan
  variables {
    status_probe_token = "short"
  }
  expect_failures = [var.status_probe_token]
}

run "refuses_a_host_outside_the_zone" {
  command = plan
  variables {
    hostname = "status.example.com"
  }
  expect_failures = [cloudflare_dns_record.status]
}
