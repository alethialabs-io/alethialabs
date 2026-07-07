# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on AWS — a single x86 EC2 box running the same self-host
# bundle (app · docs · postgres · s3 · runner) behind Caddy, fronted by a Cloudflare Tunnel.
# Ported from infra/cp-hetzner but shaped for AWS: the box has NO public web ingress (the
# security group has NO inbound rules at all), SSH is via SSM Session Manager (the agent dials
# OUT — no bastion, no open port), and the auto-assigned public IP is used purely for egress
# (image pulls, git clone, dialing the tunnel + SSM out). Cheapest correct single-box shape:
# no NAT gateway / no SSM VPC endpoints (both far dearer for one VM), no managed services — the
# encrypted root EBS holds Postgres + object storage.

locals {
  tags = {
    project = "alethia"
    role    = "control-plane"
    managed = "opentofu"
  }
}

data "aws_vpc" "default" {
  default = true
}

# Latest Ubuntu 24.04 (noble) x86_64, Canonical. The amazon-ssm-agent ships preinstalled on
# these AMIs, so Session Manager works as soon as the instance profile below is attached.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── SSM access (replaces SSH) ────────────────────────────────────────────────────
# A dedicated least-privilege instance role carrying ONLY AmazonSSMManagedInstanceCore, so
# `aws ssm start-session --target <id>` works with no inbound port and no bastion.
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cp" {
  name               = "alethia-cp"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.cp.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "cp" {
  name = "alethia-cp"
  role = aws_iam_role.cp.name
  tags = local.tags
}

# Egress-only security group: NO ingress (web is tunnel-fronted; SSH is SSM, which dials out).
resource "aws_security_group" "cp" {
  name        = "alethia-cp"
  description = "Alethia control plane: egress only (ingress via Cloudflare Tunnel; SSH via SSM)."
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags

  egress {
    description = "All egress (image pulls, git, tunnel + SSM dial-out)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "cp" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  iam_instance_profile        = aws_iam_instance_profile.cp.name
  vpc_security_group_ids      = [aws_security_group.cp.id]
  associate_public_ip_address = true # egress only — no inbound reaches it (SG has no ingress)
  tags                        = merge(local.tags, { Name = "alethia-cp" })

  # Enforce IMDSv2 (token-required) — blocks the SSRF-to-credentials class.
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  })
}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
# The origin is never exposed: cloudflared (a compose service on the box) dials OUT to
# Cloudflare and forwards the tunnel's ingress to Caddy over the internal network. TLS
# terminates at Cloudflare's edge. config_src = "cloudflare" = remotely-managed config, so the
# connector only needs the token (see the tunnel_token output → TUNNEL_TOKEN env).
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "cp" {
  account_id = var.cloudflare_account_id
  name       = "alethia-cp-aws"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cp" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cp.id

  config {
    # Apex + www forward to Caddy, which stitches console + marketing + docs + blog into the
    # one origin.
    ingress_rule {
      hostname = var.domain
      service  = "http://caddy:80"
    }
    ingress_rule {
      hostname = "www.${var.domain}"
      service  = "http://caddy:80"
    }
    # Required catch-all.
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# DNS — proxied CNAMEs onto the tunnel (Cloudflare flattens the apex CNAME). Proxied is
# mandatory for cfargotunnel.com targets; ttl must be 1 (auto) when proxied.
resource "cloudflare_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
