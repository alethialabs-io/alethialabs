# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"

  # Console HTTP state proxy — the runner supplies address/lock/unlock at
  # `tofu init -backend-config=...` (per-job token via TF_HTTP_PASSWORD). Do NOT
  # add attributes here.
  backend "http" {}

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = ">= 1.51, < 2.0"
    }
    talos = {
      source = "siderolabs/talos"
      # Floor 0.11: v0.11.0 is the first release that vendors Talos v1.13 machinery, so it is
      # the minimum that can generate valid v1.13.6 machine config. Ceiling < 0.13 keeps Terraform
      # on the 0.11.x line (0.12.x-alpha vendors Talos 1.14 machinery — not what we pin).
      # Talos-provider↔Talos coupling: this range is chosen to vendor the machinery for
      # var.talos_version (v1.13.6), whose SSOT is packages/core/compat/matrix.json → components[talos].
      # The matrix records no provider version (it is not a k8s-windowed component); bump this range
      # only when moving talos_version, keeping the two in lockstep (#1214).
      version = ">= 0.11, < 0.13"
    }
    # Uploads the Talos disk image (raw.xz) into Hetzner and snapshots it.
    # Reads the Hetzner token from the HCLOUD_TOKEN env var, same as hcloud.
    imager = {
      source  = "hcloud-talos/imager"
      version = ">= 1.0, < 2.0"
    }
    # Used only to render Cilium / hcloud-CCM Helm charts to plain manifests
    # (helm_template data source); no tiller/cluster connection needed at plan.
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.12, < 3.0"
    }
    # Hetzner-docs-endorsed provider for Object Storage (S3-compatible) buckets. The
    # provider + resources live in buckets.tf; it is only exercised when var.buckets is
    # non-empty. Reads the S3 endpoint/keys from vars (TF_VAR_hetzner_s3_*), never HCLOUD_TOKEN.
    minio = {
      source  = "aminueza/minio"
      version = "~> 3.3"
    }
  }
}

# Hetzner token is taken from the HCLOUD_TOKEN environment variable (the runner
# injects it). We deliberately do NOT declare a token variable. The raised poll
# interval keeps us under Hetzner's 3600 req/hr API rate limit during apply.
provider "hcloud" {
  poll_interval = "5s"
}

# Also reads HCLOUD_TOKEN from the environment.
provider "imager" {}

# Helm is used only to render charts to manifests (helm_template data source);
# it never connects to a cluster, so an empty config is fine.
provider "helm" {}

locals {
  cluster_name = "${var.project_name}-${var.environment}"

  # Platform base labels stamped on every hcloud resource. `cluster` is the load-bearing base label:
  # the teardown sweep (scripts/e2e/hcloud-cleanup.sh) is scoped to `cluster=<name>`, and the hcloud
  # account is SHARED WITH PROD, so this label must stay authoritative. Classification + sweep-handle
  # labels (var.classification_tags) are merged in UNDER these (base on the merge RHS) so they always
  # WIN a key collision — a renamed classification dimension can never shadow `cluster`.
  base_labels    = { cluster = local.cluster_name }
  default_labels = merge(var.classification_tags, local.base_labels)

  # Kubernetes API + Talos KubePrism ports.
  api_port_k8s        = 6443
  api_port_kube_prism = 7445

  # Architectures we actually need snapshots for (dedup CP + worker arch).
  architectures = distinct([var.control_plane_arch, var.worker_arch])
  need_arm64    = contains(local.architectures, "arm64")
  need_amd64    = contains(local.architectures, "amd64")

  # The Talos snapshot id to boot each role from, chosen by arch.
  cp_image_id     = var.control_plane_arch == "arm64" ? local.image_id_arm64 : local.image_id_amd64
  worker_image_id = var.worker_arch == "arm64" ? local.image_id_arm64 : local.image_id_amd64
}

# Resolve the requested Hetzner location (fails fast on a bad region).
data "hcloud_location" "selected" {
  name = var.region
}

locals {
  # Primary IPs are datacenter-scoped and DC names don't follow a fixed suffix,
  # so map each location to its default datacenter. Falls back to "<region>-dc1"
  # for any location not in the map (correct for ash/hil/sin).
  region_datacenter_map = {
    fsn1 = "fsn1-dc14"
    nbg1 = "nbg1-dc3"
    hel1 = "hel1-dc2"
    ash  = "ash-dc1"
    hil  = "hil-dc1"
    sin  = "sin-dc1"
  }
  region_datacenter = lookup(local.region_datacenter_map, var.region, "${var.region}-dc1")
}
