# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on GCP — a single Ampere ARM (Tau T2A) Compute
# Engine VM running the same self-host bundle as the other hosts (host-agnostic;
# the deploy-app workflow SSHes here identically). Cheapest single-box GCP shape.

locals {
  labels = {
    project = "alethia"
    role    = "control-plane"
    managed = "opentofu"
  }
}

# Latest Ubuntu 24.04 (noble) ARM64 image.
data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-arm64"
  project = "ubuntu-os-cloud"
}

resource "google_compute_address" "cp" {
  name   = "alethia-cp"
  region = var.gcp_region
}

resource "google_compute_firewall" "web" {
  name    = "alethia-cp"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = var.ssh_allowed_cidrs
  target_tags   = ["alethia-cp"]
}

resource "google_compute_instance" "cp" {
  name         = "alethia-cp"
  machine_type = var.machine_type
  zone         = var.gcp_zone
  tags         = ["alethia-cp"]
  labels       = local.labels

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.boot_disk_size
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip = google_compute_address.cp.address
    }
  }

  # Shared cloud-init (the Hetzner-volume mount step no-ops here; Docker uses the
  # boot disk, which is durable + snapshottable). Ubuntu images run cloud-init
  # from the `user-data` metadata key.
  metadata = {
    user-data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
      repo_url = var.repo_url
    })
    ssh-keys = "alethia:${var.ssh_public_key}"
  }
}

# DNS — unproxied so Caddy's ACME challenge reaches the box directly.
resource "cloudflare_record" "apex_a" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  content = google_compute_address.cp.address
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "www_a" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "A"
  content = google_compute_address.cp.address
  proxied = false
  ttl     = 300
}
