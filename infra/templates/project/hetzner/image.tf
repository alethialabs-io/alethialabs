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
# It DID start biting at 15m, so the deploy-wait is the number that moved. Second occurrence: the
# scheduled floor run 33080748841 (2026-08-27), same error, same resource, on amd64:
#
#   Error: Upload failed
#     with imager_image.amd64[0], on image.tf line 87
#   failed to create snapshot: context deadline exceeded: remaining running actions: [651580904971748]
#
# Two blowouts against a ~5m median is not a thin tail — Hetzner is sometimes several times slower
# here, and the action it reports is still RUNNING when the provider gives up. So 25m, and
# `t2_providers.go` raises hetzner's deploy-wait to 40m in the same change to contain it: 25m of
# image plus a cluster that needs ~8m does not fit in 25m of wait, and raising one alone only moves
# where the run dies. That coupling is the point the previous version of this comment made, and it
# is why these two numbers are never changed independently.
#
# THIS IS A DEADLINE, NOT A FIX. The snapshot is a pure function of talos_version + architecture +
# location, and it is rebuilt from scratch on every single run because `description` (and the
# `cluster` label the sweeper keys on) carry the cluster name. Caching it per version/arch/location
# removes the 5–15m AND the flake — see #3027, which is separate because the sweeper that keeps this
# prod-SHARED account clean deletes images by exactly that `cluster` label, so a cached image has to
# be made deliberately un-sweepable without weakening the guarantee.
#
# `delete` is bounded too: the provider tears its own rescue server down, and an unbounded delete on
# the failure path is how the scaffolding gets left behind billing (#2463).
resource "imager_image" "arm64" {
  count        = local.need_arm64 ? 1 : 0
  image_url    = one(data.talos_image_factory_urls.arm64[*].urls).disk_image
  architecture = "arm"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-arm64"
  labels       = merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "25m"
    delete = "10m"
  }
}

resource "imager_image" "amd64" {
  count        = local.need_amd64 ? 1 : 0
  image_url    = one(data.talos_image_factory_urls.amd64[*].urls).disk_image
  architecture = "x86"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-amd64"
  labels       = merge(local.default_labels, { os = "talos" })

  timeouts {
    create = "25m"
    delete = "10m"
  }
}

locals {
  image_id_arm64 = local.need_arm64 ? one(imager_image.arm64[*].image_id) : ""
  image_id_amd64 = local.need_amd64 ? one(imager_image.amd64[*].image_id) : ""
}
