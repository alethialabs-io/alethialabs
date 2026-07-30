# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the sizing check actually refuses what it claims to refuse.
#
# env_cap and server_type are one decision, and they had already drifted: the repo
# shipped a cap of 4 against an 8 GB default, on an estimate of ~2 GB per env that
# measured 5.2-7 GB on the real box. Nothing caught it, because running out of RAM
# surfaces as an OOM-killed console hours after the apply, not as a failed plan.
#
# So the check exists — and this asserts the check FIRES, because a guard nobody has
# seen fail is indistinguishable from no guard. (That is not hypothetical here: the
# hero browser gate passed for months while being incapable of failing.)
#
# Providers are mocked, so this needs no credentials and runs on contributor PRs.

mock_provider "hcloud" {
  mock_resource "hcloud_firewall" { defaults = { id = 1 } }
  mock_resource "hcloud_server" {
    defaults = { id = 2, ipv4_address = "203.0.113.10", status = "running" }
  }
  # Must match the server's address or server_holds_the_persistent_ip fails: the mock
  # would otherwise invent two different random strings.
  mock_resource "hcloud_primary_ip" {
    defaults = { id = 3, ip_address = "203.0.113.10" }
  }
  mock_resource "hcloud_ssh_key" { defaults = { id = 4 } }
  mock_resource "hcloud_firewall_attachment" { defaults = { id = 5 } }
}
mock_provider "cloudflare" {}
mock_provider "random" {}

variables {
  hcloud_token          = "mock"
  cloudflare_api_token  = "mock"
  cloudflare_account_id = "mock"
  cloudflare_zone_id    = "mock"
  ssh_public_key        = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMOCK mock"
  ssh_allowed_cidrs     = ["203.0.113.0/32"]
}

# The shipped pairing. If this ever fails, the box cannot be applied at all.
run "shipped_pairing_cpx42_cap2_is_valid" {
  command = plan
  variables {
    server_type = "cpx42"
    env_cap     = 2
  }
}

# cpx32 is half the hourly rate and tempting for that reason. It holds ONE env — and
# `dev` permanently holds one, so cpx32 leaves no branch slot at all.
run "cpx32_cannot_host_two_envs" {
  command = plan
  variables {
    server_type = "cpx32"
    env_cap     = 2
  }
  expect_failures = [check.env_cap_fits_the_memory]
}

# The exact drift that shipped: cap 4 on a 16 GB box, from the ~2 GB estimate.
run "the_cap_of_4_the_repo_shipped_is_refused" {
  command = plan
  variables {
    server_type = "cpx42"
    env_cap     = 4
  }
  expect_failures = [check.env_cap_fits_the_memory]
}

# An unknown type must SKIP rather than block — the RAM map is a convenience, not a
# registry, and a new Hetzner type should not wedge the stack until someone adds it.
run "an_unknown_server_type_does_not_block" {
  command = plan
  variables {
    server_type = "ccx63"
    env_cap     = 6
  }
}
