# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Invariant checks for the Alibaba control-plane box (per infra IaC rule #2). These assert the
# security posture the design depends on. The no-inbound invariant is structural — no
# alicloud_security_group_rule resources are declared, so the group denies all inbound by default.

# The system disk must be encrypted.
check "system_disk_encrypted" {
  assert {
    condition     = alicloud_instance.cp.system_disk_encrypted
    error_message = "cp-alibaba ECS system disk must be encrypted (system_disk_encrypted = true)."
  }
}

# The tunnel must use remotely-managed config so the box only needs the connector token.
check "tunnel_remote_config" {
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.cp.config_src == "cloudflare"
    error_message = "cp-alibaba tunnel config_src must be \"cloudflare\" (remotely-managed)."
  }
}
