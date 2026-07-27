# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Ingress for the sandbox box. There is exactly one inbound rule — SSH — because
# every environment is reached through the Cloudflare tunnel, and cloudflared dials
# OUT. Nothing on this box needs a listening public port, which matters more here
# than on the control plane: a dev box runs unreviewed branch code by design.

resource "hcloud_firewall" "sandbox" {
  name = "alethia-sandbox"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
}

resource "hcloud_firewall_attachment" "sandbox" {
  firewall_id = hcloud_firewall.sandbox.id
  server_ids  = [hcloud_server.sandbox.id]
}
