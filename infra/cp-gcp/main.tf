# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on GCP — a single Compute Engine VM running the same
# self-host bundle (app · docs · postgres · s3 · runner) behind Caddy, fronted by a
# Cloudflare Tunnel. Ported from infra/cp-hetzner but shaped for GCP: the box has NO
# public web ingress (80/443 firewalled shut, ingress dials OUT via cloudflared), SSH
# is reachable only through Identity-Aware Proxy (IAP), and the single ephemeral
# external IP exists purely for egress (image pulls, git clone, tunnel dial-out).
# Cheapest correct single-box shape: no Cloud NAT (~10x the cost for one VM), no
# managed services — the durable boot disk holds Postgres + object storage.

locals {
  labels = {
    project     = "alethia"
    role        = "control-plane"
    managed     = "opentofu"
    service     = "alethia-control-plane"
    environment = lower(var.environment)
  }
  # Google Identity-Aware Proxy TCP-forwarding source range — the only CIDR allowed to
  # reach SSH. Connect with `gcloud compute ssh alethia-cp --tunnel-through-iap`.
  iap_range = "35.235.240.0/20"
}

# Latest Ubuntu 24.04 (noble) x86_64 image — matches the linux/amd64 self-host images.
data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

# Dedicated, least-privilege service account for the box (NOT the default compute SA,
# which carries broad editor-ish scopes). It holds no project IAM roles — the VM only
# runs Docker and needs no GCP API access beyond writing its own logs/metrics.
resource "google_service_account" "cp" {
  account_id   = "alethia-cp"
  display_name = "Alethia control-plane box"
}

# SSH-only ingress, and only from the IAP range — there is no world-open port 22 and no
# 80/443. The control plane is fronted by the Cloudflare Tunnel below (cloudflared dials
# OUT), so there is no public origin to reach; TLS terminates at Cloudflare's edge.
resource "google_compute_firewall" "ssh_iap" {
  name      = "alethia-cp-ssh-iap"
  network   = "default"
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [local.iap_range]
  target_tags   = ["alethia-cp"]
}

resource "google_compute_instance" "cp" {
  name         = "alethia-cp"
  machine_type = var.machine_type
  zone         = var.gcp_zone
  tags         = ["alethia-cp"]
  labels       = local.labels

  boot_disk {
    # Durable + snapshottable — Docker's data-root (Postgres + object storage) lives here,
    # so no separate data volume is needed (unlike the Hetzner box).
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.boot_disk_size
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"
    # Empty access_config = an ephemeral external IP, used for EGRESS ONLY (inbound web is
    # unfirewalled-open nowhere; inbound SSH is IAP-only). Cheapest egress path for one box.
    access_config {}
  }

  # Verified boot chain — clears the shielded-VM hardening checks.
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  service_account {
    email = google_service_account.cp.email
    # Minimal scopes — logging + monitoring only; no cloud-platform (broad) scope.
    scopes = [
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
    ]
  }

  # Ubuntu images run cloud-init from the `user-data` metadata key. block-project-ssh-keys
  # keeps project-wide keys off the box (instance key only).
  metadata = {
    user-data              = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", { repo_url = var.repo_url })
    ssh-keys               = "alethia:${var.ssh_public_key}"
    block-project-ssh-keys = "true"
  }

  lifecycle {
    ignore_changes = [metadata["ssh-keys"]] # don't rebuild the box if the deploy key rotates
  }
}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
# The origin is never exposed: cloudflared (a compose service on the box) dials OUT to
# Cloudflare and forwards the tunnel's ingress to Caddy over the internal network. TLS
# terminates at Cloudflare's edge. config_src = "cloudflare" = remotely-managed config, so
# the connector only needs the token (see the tunnel_token output → TUNNEL_TOKEN env).
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "cp" {
  account_id = var.cloudflare_account_id
  name       = "alethia-cp-gcp"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cp" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cp.id

  config {
    # Apex + www forward to Caddy, which stitches console + marketing + docs + blog into
    # the one origin.
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
