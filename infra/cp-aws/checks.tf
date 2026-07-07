# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Invariant checks for the AWS control-plane box (per infra IaC rule #2). These assert the
# security posture the design depends on, so a careless edit fails loudly at plan time rather
# than silently exposing the box.

# The security group must NEVER have inbound rules — web is Cloudflare-Tunnel-fronted and SSH is
# SSM Session Manager (the agent dials out). Any ingress rule is a regression.
check "no_ingress" {
  assert {
    condition     = length(aws_security_group.cp.ingress) == 0
    error_message = "cp-aws security group must have NO ingress rules (ingress via Cloudflare Tunnel; SSH via SSM)."
  }
}

# The instance must require IMDSv2 (token-required) — blocks SSRF-to-credentials.
check "imdsv2_required" {
  assert {
    condition     = aws_instance.cp.metadata_options[0].http_tokens == "required"
    error_message = "cp-aws instance must require IMDSv2 (metadata_options.http_tokens = \"required\")."
  }
}

# The root EBS volume must be encrypted.
check "root_volume_encrypted" {
  assert {
    condition     = aws_instance.cp.root_block_device[0].encrypted
    error_message = "cp-aws root EBS volume must be encrypted."
  }
}

# The tunnel must use remotely-managed config so the box only needs the connector token.
check "tunnel_remote_config" {
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.cp.config_src == "cloudflare"
    error_message = "cp-aws tunnel config_src must be \"cloudflare\" (remotely-managed)."
  }
}
