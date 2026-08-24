# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Talos image build (in-Terraform, via the Talos Image Factory).
#
# 1. Create a schematic that bakes in the qemu-guest-agent extension (needed on
#    Hetzner so the VM reports its status / can be gracefully shut down).
# 2. Ask the factory for the hcloud disk-image (raw.xz) URL per architecture.
# 3. Upload that raw.xz into Hetzner and snapshot it with the imager provider —
#    the resulting snapshot id is what the servers boot from.
# ---------------------------------------------------------------------------

# Pin the exact qemu-guest-agent extension ref for the requested Talos version.
data "talos_image_factory_extensions_versions" "this" {
  talos_version = var.talos_version
  filters = {
    names = ["siderolabs/qemu-guest-agent"]
  }
}

resource "talos_image_factory_schematic" "this" {
  schematic = yamlencode({
    customization = {
      systemExtensions = {
        officialExtensions = data.talos_image_factory_extensions_versions.this.extensions_info.*.name
      }
    }
  })
}

# Factory URLs for the hcloud platform, one per architecture we actually use.
data "talos_image_factory_urls" "arm64" {
  count         = local.need_arm64 ? 1 : 0
  talos_version = var.talos_version
  schematic_id  = talos_image_factory_schematic.this.id
  platform      = "hcloud"
  architecture  = "arm64"
}

data "talos_image_factory_urls" "amd64" {
  count         = local.need_amd64 ? 1 : 0
  talos_version = var.talos_version
  schematic_id  = talos_image_factory_schematic.this.id
  platform      = "hcloud"
  architecture  = "amd64"
}

# Upload + snapshot each needed architecture. Hetzner snapshot arch names are
# "arm" / "x86" (not arm64 / amd64).
# ── `timeouts` on the image build, because its default is not generous enough. ──
#
# `imager_image` boots a rescue server, writes the Talos raw.xz into it and snapshots the disk. On
# 2026-08-24, on the FIRST hetzner run ever driven to a real apply, that failed:
#
#   Error: Upload failed
#   failed to create snapshot: context deadline exceeded: remaining running actions: [651005379737863]
#
# "remaining running actions" is Hetzner still working when the provider gave up — a deadline, not a
# rejection. A retry the same evening, same code and region, built the image and the run went on to
# PASS. So this step is FLAKY AT ITS DEADLINE, not broken (#2458), and a flake here is expensive out
# of proportion to its size: the image is built before anything else, so losing it loses the whole
# run.
#
# 15m is chosen against two numbers, not picked. The successful builds took roughly five minutes, so
# this is about triple the observed cost. And it has to sit inside the harness's 25m hetzner
# deploy-wait (`t2_providers.go`), which also has to contain a cluster that needs ~8m — so 15m is
# close to the largest value that still leaves the rest of the apply room to finish. If this ever
# starts biting at 15m, the deploy-wait is the number to revisit, not this one.
#
# `delete` is bounded too: the provider tears its own rescue server down, and an unbounded delete on
# the failure path is how the scaffolding gets left behind billing (#2463).
resource "imager_image" "arm64" {
  count        = local.need_arm64 ? 1 : 0
  image_url    = data.talos_image_factory_urls.arm64[0].urls.disk_image
  architecture = "arm"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-arm64"
  labels       = merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "15m"
    delete = "10m"
  }
}

resource "imager_image" "amd64" {
  count        = local.need_amd64 ? 1 : 0
  image_url    = data.talos_image_factory_urls.amd64[0].urls.disk_image
  architecture = "x86"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-amd64"
  labels       = merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "15m"
    delete = "10m"
  }
}

locals {
  image_id_arm64 = local.need_arm64 ? imager_image.arm64[0].image_id : ""
  image_id_amd64 = local.need_amd64 ? imager_image.amd64[0].image_id : ""
}
