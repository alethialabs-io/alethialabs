# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# CNI + cloud integration.
#
#   * Cilium in kube-proxy-replacement / native-routing mode (Talos disables
#     the built-in CNI + kube-proxy, so Cilium owns pod networking).
#   * hcloud-cloud-controller-manager for node lifecycle + private-network
#     routing (Pod CIDR routes on the Hetzner network).
#
# Both charts are rendered to plain manifests with the `helm_template` data
# source and applied with `kubectl_manifest`, so no in-cluster Helm/tiller is
# needed and everything is visible in the plan. The kubectl/helm providers are
# wired from the Talos-issued kubeconfig.
# ---------------------------------------------------------------------------

locals {
  cilium_version     = "1.16.5"
  hcloud_ccm_version = "1.24.0"

  # Parsed kubeconfig for the kubectl provider.
  kubeconfig = try(yamldecode(talos_cluster_kubeconfig.this.kubeconfig_raw), null)

  kube_host = try(local.kubeconfig.clusters[0].cluster.server, "")
  kube_ca   = try(base64decode(local.kubeconfig.clusters[0].cluster["certificate-authority-data"]), "")
  kube_cert = try(base64decode(local.kubeconfig.users[0].user["client-certificate-data"]), "")
  kube_key  = try(base64decode(local.kubeconfig.users[0].user["client-key-data"]), "")
}

provider "kubectl" {
  host                   = local.kube_host
  cluster_ca_certificate = local.kube_ca
  client_certificate     = local.kube_cert
  client_key             = local.kube_key
  load_config_file       = false
  apply_retry_count      = 5
}

# --- hcloud CCM secret (token + private network id) ------------------------
resource "kubectl_manifest" "hcloud_secret" {
  yaml_body = yamlencode({
    apiVersion = "v1"
    kind       = "Secret"
    metadata = {
      name      = "hcloud"
      namespace = "kube-system"
    }
    type = "Opaque"
    data = {
      token   = base64encode(var.hcloud_token)
      network = base64encode(tostring(hcloud_network.this.id))
    }
  })

  depends_on = [talos_cluster_kubeconfig.this]
}

# --- Cilium ----------------------------------------------------------------
data "helm_template" "cilium" {
  name       = "cilium"
  namespace  = "kube-system"
  repository = "https://helm.cilium.io"
  chart      = "cilium"
  version    = local.cilium_version

  set {
    name  = "ipam.mode"
    value = "kubernetes"
  }
  set {
    name  = "routingMode"
    value = "native"
  }
  set {
    name  = "ipv4NativeRoutingCIDR"
    value = var.pod_cidr
  }
  set {
    name  = "kubeProxyReplacement"
    value = "true"
  }
  set {
    name  = "k8sServiceHost"
    value = "127.0.0.1"
  }
  set {
    name  = "k8sServicePort"
    value = tostring(local.api_port_kube_prism)
  }
  set {
    name  = "bpf.masquerade"
    value = "false"
  }
  set {
    name  = "cgroup.autoMount.enabled"
    value = "false"
  }
  set {
    name  = "cgroup.hostRoot"
    value = "/sys/fs/cgroup"
  }
  set {
    name  = "securityContext.capabilities.ciliumAgent"
    value = "{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}"
  }
  set {
    name  = "securityContext.capabilities.cleanCiliumState"
    value = "{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}"
  }
  set {
    name  = "hubble.enabled"
    value = "false"
  }
  set {
    name  = "operator.replicas"
    value = var.control_plane_count > 1 ? "2" : "1"
  }
}

data "kubectl_file_documents" "cilium" {
  content = data.helm_template.cilium.manifest
}

resource "kubectl_manifest" "cilium" {
  for_each   = data.kubectl_file_documents.cilium.manifests
  yaml_body  = each.value
  apply_only = true

  depends_on = [talos_cluster_kubeconfig.this]
}

# --- hcloud cloud-controller-manager ---------------------------------------
data "helm_template" "hcloud_ccm" {
  name       = "hcloud-cloud-controller-manager"
  namespace  = "kube-system"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-cloud-controller-manager"
  version    = local.hcloud_ccm_version

  set {
    name  = "networking.enabled"
    value = "true"
  }
  set {
    name  = "networking.clusterCIDR"
    value = var.pod_cidr
  }
}

data "kubectl_file_documents" "hcloud_ccm" {
  content = data.helm_template.hcloud_ccm.manifest
}

resource "kubectl_manifest" "hcloud_ccm" {
  for_each   = data.kubectl_file_documents.hcloud_ccm.manifests
  yaml_body  = each.value
  apply_only = true

  depends_on = [
    kubectl_manifest.hcloud_secret,
    kubectl_manifest.cilium,
  ]
}
