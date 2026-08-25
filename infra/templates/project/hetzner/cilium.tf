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
    value = local.network_ip_range
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
    value = local.pod_cidr
  }

  # A DEFAULT LOAD BALANCER LOCATION, without which the CCM refuses to create one at all.
  #
  # hcloud-cloud-controller-manager will not provision a Load Balancer unless it can decide WHERE
  # to put it — from `HCLOUD_LOAD_BALANCERS_LOCATION`, `HCLOUD_LOAD_BALANCERS_NETWORK_ZONE`, or a
  # per-Service `load-balancer.hetzner.cloud/location` annotation. This template set none of the
  # three, so every `type: LoadBalancer` Service on a Hetzner cluster sat Pending forever. That is
  # a PRODUCT bug, not a test one: it is any customer's ingress, not just ours.
  #
  # It is also the root cause of #2490, by a chain that is worth writing down because the symptom
  # names none of it: no location → no Load Balancer → the ingress-nginx controller Service never
  # goes healthy → its ArgoCD Application sits Progressing ("waiting for healthy state of
  # /Service/addon-ingress-nginx-controller") → ArgoCD never runs PostSync → the chart's
  # `admission-patch` post-install Job never injects the admission webhook's caBundle → every
  # later Ingress is rejected with `x509: certificate signed by unknown authority`. Harbor (wave 2)
  # was the visible casualty. Only the PreSync admission hooks ever reached Succeeded, which is the
  # fingerprint of this and not of a slow wave.
  #
  # So this was never a race, and no ordering gate could have fixed it: a 5-minute wait, a 50-minute
  # wait and no wait produce the same permanent failure.
  set {
    name  = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value"
    value = data.hcloud_location.selected.name
  }

  # Reach backends over the PRIVATE network. Unconditional, because there is always one (#2549).
  #
  # This was keyed off `provision_network`, with the rationale "with no private network there is
  # nothing to route over". Both halves were wrong: `provision_network = false` does not mean "no
  # private network", it means BRING YOUR OWN. On that path `network_id` is mandatory
  # (checks_network.tf), `hcloud_network_subnet.nodes` is created either way — it carries no `count`
  # — `local.network_id` resolves from the data source, and talos.tf always writes the `network` key
  # into the `hcloud` Secret with `networking.enabled = "true"` hardcoded.
  #
  # So the BYO-network path yielded "false" and the CCM targeted the nodes' PUBLIC IPs, which
  # `hcloud_firewall.this` admits only on 50000/50001/6443. The Load Balancer's health checks would
  # never pass, ArgoCD would still mark the Service Healthy because an ingress IP had been assigned,
  # and no traffic would reach nginx. Silent, in exactly the way #2490 was silent — which is the
  # whole reason that bug survived long enough to be misdiagnosed as a race.
  #
  # The question this wants to ask is "is there a private network", not "did we create it". The
  # answer here is always yes.
  set {
    name  = "env.HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP.value"
    value = "true"
  }
}
