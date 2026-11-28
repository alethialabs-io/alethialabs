# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the stack plans what it claims and that its guards FIRE. Providers are mocked: no
# credentials, no network. .github/workflows/infra-assets-cdn.yml runs it on every PR touching the
# stack; locally: `tofu init -backend=false && tofu test` from this directory.

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

variables {
  cloudflare_account_id = "fedcba9876543210fedcba9876543210"
}

run "plans_the_committed_inputs" {
  command = plan

  assert {
    condition     = cloudflare_r2_bucket.assets.jurisdiction == "eu" && cloudflare_r2_bucket.assets.name == "alethia-public-assets"
    error_message = "the bucket must be alethia-public-assets in the EU jurisdiction."
  }

  assert {
    condition     = cloudflare_r2_custom_domain.assets.domain == "assets.alethialabs.io" && cloudflare_r2_custom_domain.assets.min_tls == "1.2"
    error_message = "the custom domain must be assets.alethialabs.io with a TLS 1.2 floor."
  }

  assert {
    condition     = cloudflare_r2_managed_domain.assets.enabled == false
    error_message = "the r2.dev URL must be disabled."
  }

  assert {
    condition     = toset(cloudflare_r2_bucket_cors.assets.rules[0].allowed.methods) == toset(["GET", "HEAD"])
    error_message = "CORS must allow reads only."
  }

  assert {
    condition     = length(cloudflare_ruleset.cache) == 1 && strcontains(cloudflare_ruleset.cache[0].rules[0].expression, "starts_with(http.request.uri.path, \"/media/\")")
    error_message = "the committed decision is to own the cache rule, scoped to the immutable prefixes."
  }

  assert {
    condition     = cloudflare_ruleset.cache[0].rules[0].action_parameters.edge_ttl.status_code_ttl[0].value == 60
    error_message = "error responses must be cached for one minute, not a year."
  }
}

run "no_cache_rule_when_the_zone_already_has_one" {
  command = plan

  variables {
    manage_cache_rule = false
  }

  assert {
    condition     = length(cloudflare_ruleset.cache) == 0
    error_message = "manage_cache_rule = false must leave the zone's cache ruleset alone."
  }
}

run "rejects_a_host_in_the_route53_subzone" {
  command = plan

  variables {
    hostname = "assets.e2e.alethialabs.io"
  }

  expect_failures = [var.hostname]
}

run "rejects_a_host_outside_the_zone" {
  command = plan

  variables {
    hostname = "assets.example.com"
  }

  expect_failures = [cloudflare_r2_custom_domain.assets]
}

run "rejects_a_cors_origin_with_a_path" {
  command = plan

  variables {
    cors_origins = ["https://alethialabs.io/"]
  }

  expect_failures = [var.cors_origins]
}

run "rejects_a_malformed_account_id" {
  command = plan

  variables {
    cloudflare_account_id = "not-an-account"
  }

  expect_failures = [var.cloudflare_account_id]
}
