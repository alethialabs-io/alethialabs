# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Invariant checks for the Azure control-plane box (per infra IaC rule #2). These assert the
# security posture the design depends on, so a careless edit fails loudly at plan time rather
# than silently exposing the box.

# The NSG must NEVER have an inbound Allow rule — web is Cloudflare-Tunnel-fronted and admin is
# `az vm run-command` (control-plane, no port). Any inbound Allow is a regression.
check "no_inbound_allow" {
  assert {
    condition = length([
      for rule in azurerm_network_security_group.cp.security_rule :
      rule if rule.direction == "Inbound" && rule.access == "Allow"
    ]) == 0
    error_message = "cp-azure NSG must have NO inbound Allow rules (ingress via Cloudflare Tunnel; admin via az vm run-command)."
  }
}

# The VM must keep Trusted Launch (secure boot + vTPM) enabled.
check "trusted_launch_enabled" {
  assert {
    condition     = azurerm_linux_virtual_machine.cp.secure_boot_enabled && azurerm_linux_virtual_machine.cp.vtpm_enabled
    error_message = "cp-azure VM must keep Trusted Launch (secure_boot_enabled + vtpm_enabled) on."
  }
}

# The tunnel must use remotely-managed config so the box only needs the connector token.
check "tunnel_remote_config" {
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.cp.config_src == "cloudflare"
    error_message = "cp-azure tunnel config_src must be \"cloudflare\" (remotely-managed)."
  }
}
