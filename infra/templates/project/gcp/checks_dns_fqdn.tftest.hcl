# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The managed zone's dnsName is the FQDN form GCP demands, whatever the caller passed (#2099).
#
# GCP rejects a dnsName that is not terminated with a dot:
#   Error 400: Invalid value for 'entity.managedZone.dnsName': '<env>.e2e.alethialabs.io', invalid
#
# Both `cloud_dns_domain` here and `domain` in modules/cloud-dns DOCUMENTED that requirement in
# prose and enforced it nowhere — and no real caller supplies it. The Go provider emits
# `config.DNS.DomainName` verbatim, and the harness's MaxConfigDomain() returns an undotted name.
# So every real gcp apply with DNS enabled died at this resource, on the 2026-08-09 full-bar
# nightly and every run before it.
#
# WHY THE SUITE MISSED IT, which is the part worth keeping: every pre-existing fixture hand-wrote
# `"example.com."` WITH the dot. The tests only ever exercised the one shape the real callers never
# produce, so a green suite said nothing about the path that actually runs. The UNDOTTED case below
# is the regression; the dotted one is here so the normalisation cannot be written as an
# unconditional append, which would produce `example.com..`.
#
# Providers are mocked and provision_gke is off, so this needs no credentials and runs on any PR.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia"

  provision_network = true
  provision_gke     = false

  cloud_dns_enabled   = true
  cloud_dns_zone_name = "primary"
}

# THE REGRESSION. This is the exact shape every real caller produces.
run "an_undotted_domain_is_normalised_to_the_fqdn_gcp_requires" {
  command = plan

  variables {
    cloud_dns_domain = "e2e-42.e2e.alethialabs.io"
  }

  assert {
    condition     = module.cloud_dns[0].dns_name == "e2e-42.e2e.alethialabs.io."
    error_message = "An undotted domain must be normalised to the trailing-dot FQDN form; GCP rejects anything else with a 400 on entity.managedZone.dnsName."
  }
}

# …and a caller that already terminated it must be left EXACTLY alone. An unconditional append
# would make this `example.com..`, which GCP rejects just as hard.
run "an_already_dotted_domain_is_untouched" {
  command = plan

  variables {
    cloud_dns_domain = "example.com."
  }

  assert {
    condition     = module.cloud_dns[0].dns_name == "example.com."
    error_message = "A domain that already ends with a dot must be passed through verbatim — appending unconditionally yields 'example.com..', which is equally invalid."
  }
}

# The zone NAME is a separate identifier from the dnsName and must not gain a dot: GCP's managed
# zone `name` is a resource id (letters, digits, hyphens), and a dot there is rejected outright.
# Pinned because both are derived from the same inputs a few lines apart.
run "the_zone_resource_name_never_gains_a_dot" {
  command = plan

  variables {
    cloud_dns_domain = "e2e-42.e2e.alethialabs.io"
  }

  assert {
    condition     = !strcontains(module.cloud_dns[0].zone_name, ".")
    error_message = "The managed zone's resource name must stay a plain id — only dnsName is a FQDN."
  }
}
