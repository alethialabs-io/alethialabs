# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the two things the platform ingress ATTACHES actually leave the template.
#
# Both the Cloud Armor security policy and the Google-managed SSL certificate were created by this
# template and exported by nothing: `modules/cloud-armor/outputs.tf` and
# `modules/cloud-dns/outputs.tf` each declared their ids, and the root swallowed every one. The
# runner therefore could not learn either existed, so the policy inspected no requests and the
# certificate fronted no load balancer — created, billed, attached to nothing (#1419).
#
# The outputs are the CONTRACT between this template and packages/core/argocd (InfraFacts reads them
# by string key in the `case "gcp"` arm of BuildFromOutputs). A rename or a dropped output is a
# permanently-empty fact on the Go side, which fails SILENTLY — `GCPIngressSA` is wired to
# `ingress_service_account`, which no template has ever exported, and has been "" since the day it
# was written. So each key is asserted by NAME here, and each is asserted null in the off direction
# too: null is the "attach nothing" signal the Go side depends on, and an output that is null in
# both directions would satisfy a one-sided test while proving nothing.
#
# Providers are mocked and provision_gke is off, so this needs no credentials and runs on any PR.
# It proves the PLAN, not an apply — see the caveat at the foot of the file.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  # Nothing that needs a cluster: the outputs under test are decided from plain variables and the
  # two small modules below, and turning the cluster on would only add mock surface.
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  create_cloud_storage        = false
}

################################################################################
# 1. Cloud Armor — the policy name the BackendConfig binds
################################################################################

# The name is what `spec.securityPolicy.name` takes, and it is asserted as a LITERAL rather than
# recomputed from the same interpolation: restating the derivation would assert only that it equals
# itself. A literal fails the moment the name moves — and moving it forces replacement of a policy
# that is, by then, fronting a live load balancer.
run "cloud_armor_exports_the_policy_name_the_backendconfig_binds" {
  command = plan

  variables {
    cloud_armor_enabled = true
  }

  assert {
    condition     = output.cloud_armor_policy_name == "alethia-nl-production-armor-policy"
    error_message = "cloud_armor_policy_name must carry the security policy's bare name, got ${coalesce(output.cloud_armor_policy_name, "<null>")}."
  }
}

# The off direction. Null — not "" and not an Invalid index — is what the runner harvests into
# jobs.execution_metadata and what ExtractOutput turns into the empty string the Go side reads as
# "build no BackendConfig". An error here would fail the whole job instead.
run "cloud_armor_outputs_are_null_when_the_switch_is_off" {
  command = plan

  variables {
    cloud_armor_enabled = false
  }

  assert {
    condition = alltrue([
      output.cloud_armor_policy_name == null,
      output.cloud_armor_policy_id == null,
      output.cloud_armor_policy_self_link == null,
    ])
    error_message = "With cloud_armor_enabled = false every Cloud Armor output must be null, not an error and not an empty string."
  }
}

################################################################################
# 2. cloud_armor_default_action — #1826
################################################################################

# The variable has existed since the template shipped, defaulting to "allow", and reached nothing:
# modules/cloud-armor hardcoded `deny(403)` on the catch-all rule. While the policy was attached to
# nothing that was invisible. Attached to the platform ingress it is an outage — enabling the WAF
# would have denied 100% of requests. The value set below is deliberately the NON-default one, so
# this run fails if the wiring is ever reverted to the hardcoded literal (a plan with the default
# would pass either way).
run "a_non_default_armor_action_is_accepted_and_reaches_the_module" {
  command = plan

  variables {
    cloud_armor_enabled        = true
    cloud_armor_default_action = "deny(404)"
  }

  assert {
    condition     = module.cloud_armor[0].default_action == "deny(404)"
    error_message = "cloud_armor_default_action must reach modules/cloud-armor — got ${module.cloud_armor[0].default_action}."
  }
}

# The set is finite and known, so it is enumerated rather than left a free string. An unvalidated
# typo is not a plan error: it is either a 400 halfway through an apply, or — for a value the API
# happens to accept — a silently different security posture than the operator asked for.
run "an_unknown_armor_action_is_refused" {
  command = plan

  variables {
    cloud_armor_enabled        = true
    cloud_armor_default_action = "denyall"
  }

  expect_failures = [var.cloud_armor_default_action]
}

################################################################################
# 3. The Google-managed SSL certificate
################################################################################

# `ingress.gcp.kubernetes.io/pre-shared-cert` takes NAMES, not ids or self links, which is why the
# module's long-standing `managed_certificate_id` was not enough on its own.
run "a_managed_certificate_exports_the_name_the_ingress_annotation_takes" {
  command = plan

  variables {
    cloud_dns_enabled             = true
    cloud_dns_zone_name           = "platform"
    cloud_dns_domain              = "example.com."
    cloud_dns_managed_certificate = true
  }

  # The name is "<zone_name>-cert-<8 hex of the SAN set>". The digest is there because changing
  # `domains` REPLACES the certificate and a certificate attached to a live load balancer cannot be
  # deleted before its replacement exists — create_before_destroy needs a differing name, and this
  # resource type has no name_prefix. Matched by shape, not by literal, so the digest is free to
  # change; the point is that it is PRESENT and that the name is not the old prefix-doubled form.
  assert {
    condition     = can(regex("^platform-cert-[0-9a-f]{8}$", output.cloud_dns_managed_certificate_name))
    error_message = "cloud_dns_managed_certificate_name must be <zone_name>-cert-<8 hex>, got ${coalesce(output.cloud_dns_managed_certificate_name, "<null>")}."
  }

  # GCP caps a resource name at 63 characters and rejects a longer one AT APPLY. The name used to
  # be "<project_name>-<environment>-<zone_name>-cert", which repeats the naming stem twice because
  # zone_name itself defaults to "dns-<region-short>-<environment>-<project_name>" — 56 characters
  # at the shipped stem budget, and 65 once the SAN digest was added, on precisely the deploys that
  # bring no zone id of their own. Bounded by construction now (stem truncated to 63-1-8), and
  # asserted here so a future prefix cannot quietly reintroduce the overflow.
  assert {
    condition     = length(output.cloud_dns_managed_certificate_name) <= 63
    error_message = "the certificate name must fit GCP's 63-character cap, got ${length(output.cloud_dns_managed_certificate_name)}: ${output.cloud_dns_managed_certificate_name}."
  }

  # THE assertion this file existed without, and the bug it hid: the certificate covered the APEX
  # (`example.com`) while the Ingress installArgoCD renders serves `argocd.example.com`. Google
  # validates every name on a managed certificate by resolving it to the attached load balancer,
  # and this module creates NO record sets — only external-dns does, from the Ingress, for
  # argocd.<domain>. So the apex could never resolve, the certificate could never leave
  # FAILED_NOT_VISIBLE, `allow-http: "false"` removed the fallback, and the ingress served nothing
  # while argocdURLGates["gcp"] reported it installed.
  #
  # Asserting the exact set rather than "contains argocd." is deliberate: an extra unserved name is
  # the same failure as the wrong name, since ONE unresolvable SAN holds the whole certificate.
  assert {
    condition     = local.platform_certificate_domains == ["argocd.example.com"]
    error_message = "the managed certificate must cover exactly the hostnames the platform serves (argocd.<domain>) and nothing else — an unserved name, the bare apex included, holds the whole certificate in FAILED_NOT_VISIBLE. Got ${jsonencode(local.platform_certificate_domains)}."
  }
}

# DNS on, certificate off: the zone exists and the certificate does not, so the name must be null
# and the ArgoCD ingress must not render. This is the case that distinguishes "no certificate" from
# "no DNS" — without it a template that never created a certificate would pass run 3 above by
# failing it, and pass nothing else.
run "no_certificate_means_a_null_name_even_with_dns_on" {
  command = plan

  variables {
    cloud_dns_enabled             = true
    cloud_dns_zone_name           = "platform"
    cloud_dns_domain              = "example.com."
    cloud_dns_managed_certificate = false
  }

  assert {
    condition = alltrue([
      output.cloud_dns_managed_certificate_name == null,
      output.cloud_dns_managed_certificate_id == null,
      output.cloud_dns_zone_name != null,
    ])
    error_message = "With the certificate off the certificate outputs must be null while the zone output stays populated."
  }
}

################################################################################
# 4. The cloud-dns outputs vs. a pluggable DNS connector
################################################################################

# `cloud_dns_name_servers` and `cloud_dns_zone_name` used to index `module.cloud_dns[0]` off
# `var.cloud_dns_enabled`, which is only HALF the module's count: cloud-dns.tf also requires
# `dns_provider == "native"`, because selecting the Cloudflare DNS connector means the zone is not
# ours to create. A DNS-enabled project on the Cloudflare connector therefore planned
#
#   Error: Invalid index … module.cloud_dns is empty tuple
#
# and failed the WHOLE apply — the identical bug `artifact_registry_urls` shipped with, a mile from
# its cause. Every output in the block now guards on `length(module.cloud_dns)`, which cannot drift
# from the count the way a duplicated predicate did.
run "dns_outputs_survive_a_pluggable_dns_connector" {
  command = plan

  variables {
    cloud_dns_enabled             = true
    cloud_dns_zone_name           = "platform"
    cloud_dns_domain              = "example.com."
    cloud_dns_managed_certificate = true
    dns_provider                  = "cloudflare"
  }

  assert {
    condition = alltrue([
      length(module.cloud_dns) == 0,
      output.cloud_dns_zone_name == null,
      output.cloud_dns_name_servers == [],
      output.cloud_dns_managed_certificate_name == null,
      output.cloud_dns_managed_certificate_id == null,
    ])
    error_message = "With a pluggable DNS connector the cloud-dns module must be absent and every one of its outputs must resolve to a null/empty value rather than an Invalid index."
  }
}

################################################################################
# What this file does NOT prove
################################################################################
#
# Everything here is a PLAN against mocked providers. It proves the output KEYS exist, carry the
# names the runner reads, are null in the off direction, and that the certificate's SAN set is
# exactly the hostnames the platform serves. It does not prove that the GCLB actually enforces the
# policy, that the managed certificate ever reaches ACTIVE, or that the GKE ingress controller
# accepts the BackendConfig — those need a real apply, and T2 real applies are main-gated (they
# cannot run from a PR). The Go half of the contract is pinned separately: a unit test in
# packages/core/argocd asserts BuildFromOutputs reads exactly these keys, so a rename here reddens
# both sides.
#
# The SAN assertion is worth its own note, because it is a NECESSARY condition for ACTIVE that a
# plan CAN check. Reaching ACTIVE additionally needs each name to resolve to this load balancer,
# which depends on external-dns running post-apply — unprovable here. But a certificate whose SAN
# set does not include the name being served can never reach ACTIVE no matter what resolves, and
# that is precisely the state this template shipped in before: apex-only, permanently
# FAILED_NOT_VISIBLE, reported as installed.
