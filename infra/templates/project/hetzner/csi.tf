# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Hetzner CSI driver (github.com/hetznercloud/csi-driver).
#
# Provides persistent volumes (Hetzner block storage) for in-cluster stateful
# services (CloudNativePG, Redis, ...). The `hcloud-volumes` StorageClass is
# made the cluster DEFAULT. Uses the same `hcloud` secret (token) as the CCM.
#
# Rendered from the Helm chart via `helm_template` and applied with
# `kubectl_manifest`, consistent with Cilium / CCM above.
# ---------------------------------------------------------------------------

locals {
  hcloud_csi_version = "2.13.0"
}

data "helm_template" "hcloud_csi" {
  name       = "hcloud-csi"
  namespace  = "kube-system"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-csi"
  version    = local.hcloud_csi_version

  # Reuse the existing `hcloud` secret (created by kubectl_manifest.hcloud_secret).
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

data "kubectl_file_documents" "hcloud_csi" {
  content = data.helm_template.hcloud_csi.manifest
}

resource "kubectl_manifest" "hcloud_csi" {
  for_each   = data.kubectl_file_documents.hcloud_csi.manifests
  yaml_body  = each.value
  apply_only = true

  depends_on = [
    kubectl_manifest.hcloud_secret,
    kubectl_manifest.cilium,
  ]
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
