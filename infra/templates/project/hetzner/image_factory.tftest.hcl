# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The Talos Image Factory must not be on the PLAN path (#5618). The floor nightly died at planning on
# 2026-10-07 and 2026-10-08 because `data "talos_image_factory_extensions_versions"` made a live GET of
# factory.talos.dev on every plan — cache hits included — and a TLS handshake timeout there failed the
# whole run. These runs pin the two halves of the fix:
#
#   1. The schematic is built from the REQUESTED extension list (`local.talos_image_extensions`),
#      never from a factory answer. The talos mock below returns a factory answer that DISAGREES with
#      the request; a template that still routed the schematic through that lookup plans the mock's
#      extension and fails the first run.
#   2. On a cache HIT nothing factory-backed is planned at all: no schematic (a POST at apply) and no
#      URL lookups. A hit must not depend on the factory being reachable.

mock_provider "hcloud" {
  mock_resource "hcloud_network" {
    defaults = { id = "4141" }
  }
  mock_resource "hcloud_firewall" {
    defaults = { id = "4142" }
  }
  mock_resource "hcloud_primary_ip" {
    defaults = { id = "4143" }
  }
  mock_data "hcloud_firewalls" {
    defaults = { firewalls = [] }
  }
  mock_data "hcloud_servers" {
    defaults = { servers = [] }
  }
}

mock_provider "talos" {
  # A factory answer that is NOT what was requested — standing in for every way the live lookup could
  # differ from the request (an empty or partial answer, a filtered-out name). If the schematic is
  # ever wired back through this data source, run 1 sees this name instead of the requested one.
  mock_data "talos_image_factory_extensions_versions" {
    defaults = {
      extensions_info = [
        {
          name        = "siderolabs/not-what-was-requested"
          ref         = "ghcr.io/siderolabs/not-what-was-requested:0.0.0"
          digest      = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
          author      = "mock"
          description = "mock"
        },
      ]
    }
  }
}

mock_provider "imager" {}
mock_provider "minio" {}

variables {
  project_name = "acme"
  environment  = "dev"
  region       = "fsn1"
}

# ── 1. A build (cache disabled): the schematic carries exactly the requested extensions. ──────────
run "schematic_is_the_requested_extension_list" {
  command = plan

  variables {
    talos_image_cache = "disabled"
  }

  assert {
    condition     = length(talos_image_factory_schematic.this) == 1
    error_message = "A cache-disabled plan builds the image, so exactly one schematic must be planned."
  }

  assert {
    condition     = jsonencode(yamldecode(talos_image_factory_schematic.this[0].schematic).customization.systemExtensions.officialExtensions) == jsonencode(local.talos_image_extensions)
    error_message = "The schematic's officialExtensions must be exactly local.talos_image_extensions — the list the cache key hashes — and not anything an Image Factory lookup returned at plan (#5618)."
  }

  assert {
    condition     = contains(local.talos_image_extensions, "siderolabs/qemu-guest-agent")
    error_message = "The Hetzner image must bake in siderolabs/qemu-guest-agent."
  }

  assert {
    condition     = length(data.talos_image_factory_urls.amd64) == 1 && length(data.talos_image_factory_urls.arm64) == 0
    error_message = "With defaults, only the amd64 factory URL may be looked up on a build."
  }
}

# ── 2. A cache HIT: nothing factory-backed is planned. ────────────────────────────────────────────
# The cached snapshot carries every label the stamp writes, so image.tf's hit precondition passes.
# `alethia.io/talos-schematic` is the first 32 hex chars of sha256(jsonencode(["siderolabs/qemu-guest-agent"]));
# it must change with the extension list, and this run fails (on that precondition) if it does not.
override_data {
  target = data.hcloud_images.talos_cache
  values = {
    images = [
      {
        id           = 424242
        architecture = "x86"
        created      = "2026-10-01T00:00:00+00:00"
        deprecated   = ""
        description  = "alethia-talos-v1.13.6-amd64-830041721bf1bd49d6070de145372388"
        name         = ""
        os_flavor    = "unknown"
        os_version   = ""
        rapid_deploy = false
        type         = "snapshot"
        labels = {
          "alethia.io/cache"           = "talos-image"
          "alethia.io/talos-version"   = "v1.13.6"
          "alethia.io/talos-location"  = "fsn1"
          "alethia.io/talos-schematic" = "830041721bf1bd49d6070de145372388"
          "alethia.io/talos-arch"      = "x86"
          os                           = "talos"
        }
      },
    ]
  }
}

override_data {
  target = data.hcloud_images.cache_lookup_probe
  values = {
    images = [
      {
        id           = 1
        architecture = "x86"
        created      = "2026-10-01T00:00:00+00:00"
        deprecated   = ""
        description  = "Debian 12"
        name         = ""
        os_flavor    = "debian"
        os_version   = "12"
        rapid_deploy = false
        type         = "system"
        labels       = {}
      },
    ]
  }
}

run "a_cache_hit_plans_no_factory_call" {
  command = plan

  variables {
    talos_image_cache = "enabled"
  }

  assert {
    condition     = local.talos_image_cache_hit.amd64 && local.image_id_amd64 == "424242"
    error_message = "The mocked cache entry must be read as a hit and its snapshot id used."
  }

  assert {
    condition     = length(talos_image_factory_schematic.this) == 0
    error_message = "A cache hit must not plan an Image Factory schematic: creating one is a factory call, and a hit must not depend on the factory (#5618)."
  }

  assert {
    condition     = length(data.talos_image_factory_urls.amd64) == 0 && length(data.talos_image_factory_urls.arm64) == 0
    error_message = "A cache hit must not look up any Image Factory URL."
  }

  assert {
    condition     = length(imager_image.amd64) == 0 && length(imager_image.arm64) == 0
    error_message = "A cache hit must not build an image."
  }
}
