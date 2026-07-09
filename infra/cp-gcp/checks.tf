# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Invariant checks for the GCP control-plane box (per infra IaC rule #2). These assert the
# security posture the design depends on, so a careless edit fails loudly at plan time rather
# than silently exposing the box.

# The firewall must NEVER open web ports on the box — ingress is Cloudflare-Tunnel only.
check "no_web_ingress" {
  assert {
    condition = alltrue([
      for rule in google_compute_firewall.ssh_iap.allow :
      !contains(rule.ports, "80") && !contains(rule.ports, "443")
    ])
    error_message = "cp-gcp firewall must not open 80/443 — web ingress is via the Cloudflare Tunnel only."
  }
}

# SSH must be reachable ONLY from the IAP range (no world-open port 22).
check "ssh_is_iap_only" {
  assert {
    condition     = tolist(google_compute_firewall.ssh_iap.source_ranges) == [local.iap_range]
    error_message = "cp-gcp SSH firewall source_ranges must be exactly the IAP range (${local.iap_range})."
  }
}

# The VM must keep Shielded VM fully enabled.
check "shielded_vm_enabled" {
  assert {
    condition = (
      google_compute_instance.cp.shielded_instance_config[0].enable_secure_boot &&
      google_compute_instance.cp.shielded_instance_config[0].enable_vtpm &&
      google_compute_instance.cp.shielded_instance_config[0].enable_integrity_monitoring
    )
    error_message = "cp-gcp instance must keep Shielded VM (secure boot + vTPM + integrity monitoring) enabled."
  }
}

# The tunnel must use remotely-managed config so the box only needs the connector token.
check "tunnel_remote_config" {
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.cp.config_src == "cloudflare"
    error_message = "cp-gcp tunnel config_src must be \"cloudflare\" (remotely-managed)."
  }
}
