# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# CNI + cloud integration — rendered offline, applied post-apply by the runner.
#
#   * Cilium in kube-proxy-replacement / native-routing mode (Talos disables
#     the built-in CNI + kube-proxy, so Cilium owns pod networking).
#   * hcloud-cloud-controller-manager for node lifecycle + private-network
#     routing (Pod CIDR routes on the Hetzner network).
#
# Both are rendered to plain manifests with the `helm_template` DATA source
# (offline — no cluster connection, resolves at plan time) and exported via the
# `bootstrap_manifests` OUTPUT (see talos.tf / outputs.tf). The runner applies
# them with `kubectl` AFTER apply, before the reachability gate. There is
# deliberately NO in-tofu `kubectl`/`helm` PROVIDER wired from the cluster's own
# (known-after-apply) kubeconfig: that made the provider unresolvable under
# `tofu plan -out` — the runner's path (tofu.go `Plan(tfexec.Out(...))`) — so the
# runner could never deploy this template. (These are large — Cilium alone busts
# Hetzner's 32 KiB cloud-init user_data limit — so they can't ride in the Talos
# machine config as inlineManifests; post-apply also matches how the managed
# clouds do their post-cluster work.)
# ---------------------------------------------------------------------------

locals {
  # SSOT for the Cilium↔k8s and CCM↔k8s couplings: packages/core/compat/matrix.json →
  # components[cilium] / components[hcloud-ccm]. The compat couplings drift test asserts these are
  # recorded matrix releases compatible with the pinned kubernetes_version (#1214).
  cilium_version     = "1.19.6"
  hcloud_ccm_version = "1.34.0"

  # kube_version for the offline helm renders. The Cilium chart requires k8s
  # >= 1.21; the helm provider otherwise defaults to 1.20 and the render fails.
  # Pin from the requested Kubernetes version, else a safe recent default matching
  # the pinned Talos k8s (var.kubernetes_version default 1.35.6).
  render_kube_version = var.kubernetes_version == "" ? "1.35.6" : var.kubernetes_version
}

# --- Cilium ----------------------------------------------------------------
data "helm_template" "cilium" {
  name         = "cilium"
  namespace    = "kube-system"
  repository   = "https://helm.cilium.io"
  chart        = "cilium"
  version      = local.cilium_version
  kube_version = local.render_kube_version

  set {
    name  = "ipam.mode"
    value = "kubernetes"
  }
  set {
    name  = "routingMode"
    value = "native"
  }
  set {
    # The native-routing CIDR is the whole network SUPERNET (pods + services +
    # nodes are all subnets of it), NOT just the pod CIDR. This matches the
    # canonical hcloud-k8s cloud config and is what makes cross-node host<->pod
    # routing work: node IPs stay inside the native-routing CIDR (so pod->node-IP
    # is native-routed, not dropped as unroutable), and the CP host can route the
    # apiserver's reply to a remote pod over `network_cidr via <gw> dev eth1`.
    # A pod-only native-routing CIDR (disjoint from the network) breaks pod->apiserver
    # across nodes — the apiserver reply has no host route. (Verified on real infra.)
    name  = "ipv4NativeRoutingCIDR"
    value = var.network_cidr
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

# --- hcloud cloud-controller-manager ---------------------------------------
data "helm_template" "hcloud_ccm" {
  name         = "hcloud-cloud-controller-manager"
  namespace    = "kube-system"
  repository   = "https://charts.hetzner.cloud"
  chart        = "hcloud-cloud-controller-manager"
  version      = local.hcloud_ccm_version
  kube_version = local.render_kube_version

  set {
    name  = "networking.enabled"
    value = "true"
  }
  set {
    name  = "networking.clusterCIDR"
    value = var.pod_cidr
  }
}
