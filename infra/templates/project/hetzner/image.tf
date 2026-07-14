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
resource "imager_image" "arm64" {
  count        = local.need_arm64 ? 1 : 0
  image_url    = data.talos_image_factory_urls.arm64[0].urls.disk_image
  architecture = "arm"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-arm64"
  labels       = merge(local.default_labels, { os = "talos" })
}

resource "imager_image" "amd64" {
  count        = local.need_amd64 ? 1 : 0
  image_url    = data.talos_image_factory_urls.amd64[0].urls.disk_image
  architecture = "x86"
  location     = var.region
  description  = "${local.cluster_name}-talos-${var.talos_version}-amd64"
  labels       = merge(local.default_labels, { os = "talos" })
}

locals {
  image_id_arm64 = local.need_arm64 ? imager_image.arm64[0].image_id : ""
  image_id_amd64 = local.need_amd64 ? imager_image.amd64[0].image_id : ""
}
