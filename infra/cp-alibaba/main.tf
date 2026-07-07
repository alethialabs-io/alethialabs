# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on Alibaba Cloud — a single x86 (g7) ECS instance
# running the same self-host bundle (app · docs · postgres · s3 · runner) behind Caddy, fronted by
# a Cloudflare Tunnel. Ported from infra/cp-hetzner but shaped for Alibaba: the box has NO public
# web ingress (the security group has NO inbound rules), and there is NO open SSH. Admin / deploy is
# via ECS Session Manager + Cloud Assistant RunCommand (over the Cloud Assistant agent — preinstalled
# on Alibaba's official Ubuntu images — which dials OUT, no open port). The auto-assigned public IP is
# egress-only (image pulls, git clone, dialing the tunnel + CA out). The encrypted system disk holds
# Postgres + object storage.

locals {
  tags = {
    project = "alethia"
    role    = "control-plane"
    managed = "opentofu"
  }
}

# Ubuntu 24.04 LTS, x86_64, from the system image catalogue.
data "alicloud_images" "ubuntu" {
  owners       = "system"
  architecture = "x86_64"
  name_regex   = "^ubuntu_24_04_x64"
  most_recent  = true
}

# Zones that actually offer the x86 instance type (used when zone_id is unset).
data "alicloud_instance_types" "arm" {
  instance_type        = var.instance_type
  availability_zone    = var.zone_id != "" ? var.zone_id : null
  instance_type_family = "ecs.g7"
}

resource "alicloud_vpc" "cp" {
  vpc_name   = "alethia-cp"
  cidr_block = "10.30.0.0/16"
  tags       = local.tags
}

resource "alicloud_vswitch" "cp" {
  vswitch_name = "alethia-cp"
  vpc_id       = alicloud_vpc.cp.id
  cidr_block   = "10.30.1.0/24"
  zone_id      = var.zone_id != "" ? var.zone_id : data.alicloud_instance_types.arm.instance_types[0].availability_zones[0]
  tags         = local.tags
}

# Security group with NO inbound rules — web is Cloudflare-Tunnel-fronted and admin is ECS Session
# Manager / Cloud Assistant (the CA agent dials out). Alibaba security groups deny inbound by default,
# so the absence of ingress rules IS the closed posture; egress is allowed by default.
resource "alicloud_security_group" "cp" {
  security_group_name = "alethia-cp"
  vpc_id              = alicloud_vpc.cp.id
  tags                = local.tags
}

resource "alicloud_instance" "cp" {
  instance_name   = "alethia-cp"
  instance_type   = var.instance_type
  image_id        = data.alicloud_images.ubuntu.images[0].id
  vswitch_id      = alicloud_vswitch.cp.id
  security_groups = [alicloud_security_group.cp.id]

  system_disk_category  = "cloud_essd"
  system_disk_size      = var.system_disk_size
  system_disk_encrypted = true

  # Auto-assigned public IPv4 for EGRESS only (image pulls, git, tunnel + Cloud Assistant dial-out).
  # Inbound is closed by the security group; ingress is the tunnel, admin is Session Manager.
  internet_max_bandwidth_out = 5
  internet_charge_type       = "PayByTraffic"

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  })

  tags = local.tags
}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
# The origin is never exposed: cloudflared (a compose service on the box) dials OUT to Cloudflare
# and forwards the tunnel's ingress to Caddy over the internal network. TLS terminates at
# Cloudflare's edge. config_src = "cloudflare" = remotely-managed config, so the connector only
# needs the token (see the tunnel_token output → TUNNEL_TOKEN env).
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "cp" {
  account_id = var.cloudflare_account_id
  name       = "alethia-cp-alibaba"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cp" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cp.id

  config {
    # Apex + www forward to Caddy, which stitches console + marketing + docs + blog into the one
    # origin.
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

# DNS — proxied CNAMEs onto the tunnel (Cloudflare flattens the apex CNAME). Proxied is mandatory
# for cfargotunnel.com targets; ttl must be 1 (auto) when proxied.
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
