# checks.tf — post-plan invariants for the cp-hetzner control-plane stack. Assert the
# things that must hold so drift/misconfig fails loudly instead of silently serving wrong.

# get.<domain> must be a proxied CNAME pointed at THIS tunnel — otherwise the CLI
# install-script host (curl … | sh) resolves to the wrong place or bypasses the tunnel.
check "get_dns_onto_tunnel" {
  assert {
    condition = (
      cloudflare_record.get.proxied &&
      cloudflare_record.get.content == "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
    )
    error_message = "get.<domain> must be a proxied CNAME onto the cp tunnel (<tunnel-id>.cfargotunnel.com)."
  }
}
