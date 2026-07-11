# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Hetzner CSI driver (github.com/hetznercloud/csi-driver).
#
# Provides persistent volumes (Hetzner block storage) for in-cluster stateful
# services (CloudNativePG, Redis, ...). The `hcloud-volumes` StorageClass is
# made the cluster DEFAULT. Reuses the same `hcloud` Secret (token) as the CCM.
#
# Rendered offline via `helm_template` and delivered to the cluster through
# Talos `cluster.inlineManifests` (see talos.tf) — consistent with Cilium/CCM,
# and with no in-tofu kubectl provider (so `tofu plan -out` stays resolvable).
# ---------------------------------------------------------------------------

locals {
  hcloud_csi_version = "2.13.0"
}

data "helm_template" "hcloud_csi" {
  name         = "hcloud-csi"
  namespace    = "kube-system"
  repository   = "https://charts.hetzner.cloud"
  chart        = "hcloud-csi"
  version      = local.hcloud_csi_version
  kube_version = local.render_kube_version

  # Reuse the existing `hcloud` secret (delivered as an inline manifest).
  set {
    name  = "controller.hcloudToken.existingSecret.name"
    value = "hcloud"
  }
  set {
    name  = "controller.hcloudToken.existingSecret.key"
    value = "token"
  }

  # Make hcloud-volumes the default StorageClass.
  set {
    name  = "storageClasses[0].name"
    value = "hcloud-volumes"
  }
  set {
    name  = "storageClasses[0].defaultStorageClass"
    value = "true"
  }
  set {
    name  = "storageClasses[0].reclaimPolicy"
    value = "Delete"
  }
}

locals {
  # Detect the default StorageClass in the rendered CSI manifests — used by
  # checks.tf to assert the CSI/StorageClass resources are actually present.
  csi_manifest_yaml = data.helm_template.hcloud_csi.manifest

  csi_has_storageclass = can(regex("kind:\\s*StorageClass", local.csi_manifest_yaml))
  csi_has_default_sc = can(regex(
    "storageclass.kubernetes.io/is-default-class:\\s*\"true\"",
    local.csi_manifest_yaml
  ))
  csi_has_driver = can(regex("csi.hetzner.cloud", local.csi_manifest_yaml))
}
