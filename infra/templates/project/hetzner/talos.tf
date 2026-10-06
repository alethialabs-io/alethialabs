# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ---------------------------------------------------------------------------
# Talos bootstrap chain:
#   machine_secrets
#     -> data.talos_machine_configuration (controlplane + worker, with patches)
#       -> talos_machine_configuration_apply (per node)
#         -> talos_machine_bootstrap (once, depends on the CP apply)
#           -> talos_cluster_kubeconfig (depends on bootstrap)
#   + data.talos_client_configuration (talosconfig)
# ---------------------------------------------------------------------------

resource "talos_machine_secrets" "this" {
  talos_version = var.talos_version
}

locals {
  cluster_endpoint = "https://${local.control_plane_public_ip}:${local.api_port_k8s}"

  # Cert SANs so kubectl/talosctl can reach the API over any CP public IP.
  cert_sans = distinct(concat(
    local.control_plane_public_ips,
    local.control_plane_private_ips,
    ["127.0.0.1"],
  ))

  # kubernetes_version is optional — only pass it when the caller set one.
  kubernetes_version_arg = var.kubernetes_version == "" ? null : var.kubernetes_version

  # Common machine patch: install disk + private-network node IP.
  common_machine_patch = {
    machine = {
      install = {
        disk = "/dev/sda"
      }
      kubelet = {
        extraArgs = {
          "cloud-provider" = "external"
        }
        nodeIP = {
          validSubnets = [local.node_subnet_cidr]
        }
      }
      certSANs = local.cert_sans
      # Trust the in-cluster registries over plain HTTP. containerd defaults to HTTPS for every
      # non-localhost host, so a Harbor exposed as a ClusterIP with TLS off is unreachable to the
      # kubelet until it is listed here — the pull fails looking like a credential problem.
      #
      # A `mirrors` entry (not `config.tls`) is what allows the http:// scheme; the endpoint is the
      # same host, so this grants plain-HTTP access to that host and nothing else.
      #
      # This does NOT replace nodes: hcloud_server carries ignore_changes = [user_data, image], and
      # talos_machine_configuration_apply pushes the change over the Talos API.
      registries = length(var.incluster_registry_hosts) == 0 ? null : {
        mirrors = {
          for host in var.incluster_registry_hosts : host => {
            endpoints = ["http://${host}"]
          }
        }
      }
    }
  }

  # Cluster patch (base — applied to every node): disable the default CNI + kube-proxy
  # (Cilium owns them) and set the pod/service CIDRs.
  cluster_patch = {
    cluster = {
      network = {
        cni = {
          name = "none"
        }
        podSubnets     = [local.pod_cidr]
        serviceSubnets = [local.service_cidr]
      }
      proxy = {
        disabled = true
      }
      # Short-lived admin kubeconfig (#1389 placement parity). The Talos machine API mints a FRESH
      # admin cert on every `Kubeconfig` call, but the cert's TTL is a cluster-side setting whose
      # default is 1 YEAR. Pinned low (1h, #5326). The runner never holds one cert past a step: the
      # dedicated deploy re-mints from the talosconfig output before each post-apply step, and probe,
      # drift, destroy and placements mint per use (#5330). The `kubeconfig` output's stored cert is
      # stale an hour after the apply and is not read.
      adminKubeconfig = {
        certLifetime = var.admin_kubeconfig_cert_lifetime
      }
    }
  }

  control_plane_patches = [yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch)]
  worker_base_patches   = [yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch)]

  # ── Node labels and taints (#5536, contract #5533), mapped from local.nodepool_contract_render
  #    (the contract's render, at the bottom of THIS file; it must stay in talos.tf, see there) into
  #    Talos's spelling.
  #
  # LABELS go in machine.nodeLabels (Talos v1.13.6 config schema: map[string]string). Talos's
  # NodeApplyController keeps them reconciled on the Node object with the kubelet's own credentials,
  # so a changed label reaches running nodes on the next apply. NodeRestriction lets a kubelet set
  # any label outside kubernetes.io / k8s.io, and the contract refuses those domains anyway.
  #
  # TAINTS go in the kubelet's registerWithTaints (KubeletConfiguration, set through
  # machine.kubelet.extraConfig), NOT in machine.nodeTaints, for two reasons read from the pinned
  # sources:
  #   1. machine.nodeTaints is applied by the same controller with the KUBELET's credentials, and
  #      the NodeRestriction admission plugin (which Talos always enables on kube-apiserver) refuses
  #      a node that modifies its own taints: "node %q is not allowed to modify taints"
  #      (kubernetes plugin/pkg/admission/noderestriction/admission.go, Update branch). Talos's own
  #      schema notes this for worker nodes. A taint at REGISTRATION (Create) is allowed.
  #   2. machine.nodeTaints is a map keyed by taint key (one NodeTaintSpec per key), so the
  #      contract's gpu=true:NoSchedule + gpu=true:NoExecute could not both be expressed.
  # registerWithTaints rather than the --register-with-taints flag: the flag is deprecated on the
  # kubelet side (Talos v1.13.6 kubelet_spec.go says so where it checks for it). The config field is
  # the same registration-only mechanism: k8s.io/kubelet v0.36.2 (Talos v1.13.6's pin)
  # config/v1beta1 KubeletConfiguration.RegisterWithTaints []v1.Taint, "upon the initial
  # registration of the node". Talos merges extraConfig into the KubeletConfiguration it writes
  # (prepareExtraConfig), and registerWithTaints is not one of its ProtectedConfigurationFields
  # (pkg/machinery/kubelet/kubelet.go@v1.13.6).
  # The consequence, stated in the docs: a taint is set when a node registers. Changing a pool's
  # taints reaches the servers created after the change, not the nodes already registered.
  #
  # Defaults render no extra patch at all, so the default workers' config is byte-identical to the
  # template without these variables (nodepool_hetzner.tftest.hcl).
  worker_labels_patch = yamlencode({
    machine = {
      nodeLabels = local.nodepool_contract_render["default"].labels
    }
  })

  nodepool_talos_pool_patch = {
    for name, p in local.node_pools : name => yamlencode({
      machine = {
        nodeLabels = local.nodepool_contract_render[name].labels
        # extraConfig only when the pool has a taint, so an untainted pool's patch carries no empty
        # kubelet setting.
        kubelet = merge(
          {
            # Appended to the common patch's node subnet (Talos merges lists), so the kubelet picks
            # its node IP from this pool's own /24 (servers.tf).
            nodeIP = {
              validSubnets = [hcloud_network_subnet.node_pools[name].ip_range]
            }
          },
          length(local.nodepool_contract_render[name].taints) == 0 ? {} : {
            # A Taint's value is omitted when empty, as the API server would store it.
            extraConfig = {
              registerWithTaints = [
                for t in local.nodepool_contract_render[name].taints :
                t.value == "" ? { key = t.key, effect = t.effect } : { key = t.key, value = t.value, effect = t.effect }
              ]
            }
          },
        )
      }
    })
  }

  # The default workers: the same two patches as before, plus a labels patch only when node_labels
  # sets any. node_taints never reach the default pool (contract): it runs the platform's add-ons.
  worker_patches = concat(
    local.worker_base_patches,
    length(local.nodepool_contract_render["default"].labels) > 0 ? [local.worker_labels_patch] : [],
  )

  # An extra pool: the default workers' base patches (secrets, CNI, kubelet, registries) plus its own.
  node_pool_patches = {
    for name, p in local.node_pools : name => concat(local.worker_base_patches, [local.nodepool_talos_pool_patch[name]])
  }

  # Bootstrap manifests (CNI + cloud integration), rendered OFFLINE by the `helm_template`
  # data sources (cilium.tf / csi.tf) and applied POST-APPLY by the runner (`kubectl apply`),
  # NOT embedded in the Talos machine config. Two reasons this beats Talos inlineManifests
  # here: (1) the machine config ships as Hetzner cloud-init `user_data`, capped at 32 KiB —
  # Cilium's rendered manifest alone blows that; (2) it keeps the runner's post-cluster path
  # consistent with the managed clouds (which apply ArgoCD/add-ons post-apply). It still
  # avoids the in-tofu `kubectl` provider (the `plan -out` bug), because these are OUTPUTS
  # (offline data sources), never applied in-tofu. Order: Secret → Cilium (CNI) → CCM → CSI.
  hcloud_secret_manifest = yamlencode({
    apiVersion = "v1"
    kind       = "Secret"
    metadata   = { name = "hcloud", namespace = "kube-system" }
    type       = "Opaque"
    data = {
      token   = base64encode(var.hcloud_token)
      network = base64encode(tostring(local.network_id))
    }
  })
  bootstrap_manifests = join("\n---\n", [
    local.hcloud_secret_manifest,
    data.helm_template.cilium.manifest,
    data.helm_template.hcloud_ccm.manifest,
    data.helm_template.hcloud_csi.manifest,
  ])
}

data "talos_machine_configuration" "control_plane" {
  cluster_name       = local.cluster_name
  cluster_endpoint   = local.cluster_endpoint
  machine_type       = "controlplane"
  machine_secrets    = talos_machine_secrets.this.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = local.kubernetes_version_arg
  config_patches     = local.control_plane_patches
  docs               = false
  examples           = false
}

data "talos_machine_configuration" "worker" {
  cluster_name       = local.cluster_name
  cluster_endpoint   = local.cluster_endpoint
  machine_type       = "worker"
  machine_secrets    = talos_machine_secrets.this.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = local.kubernetes_version_arg
  config_patches     = local.worker_patches
  docs               = false
  examples           = false
}

# One worker machine configuration per extra pool, from the SAME machine secrets as every other
# node, so the pool's servers join this cluster and no other.
data "talos_machine_configuration" "node_pool" {
  for_each = local.node_pools

  cluster_name       = local.cluster_name
  cluster_endpoint   = local.cluster_endpoint
  machine_type       = "worker"
  machine_secrets    = talos_machine_secrets.this.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = local.kubernetes_version_arg
  config_patches     = local.node_pool_patches[each.key]
  docs               = false
  examples           = false
}

data "talos_client_configuration" "this" {
  cluster_name         = local.cluster_name
  client_configuration = talos_machine_secrets.this.client_configuration
  endpoints            = local.control_plane_public_ips
}

# Apply machine config to each node over the Talos API (public IP).
resource "talos_machine_configuration_apply" "control_plane" {
  for_each = local.control_planes

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.control_plane.machine_configuration
  node                        = hcloud_primary_ip.control_plane_ipv4[each.value.index].ip_address
  endpoint                    = hcloud_primary_ip.control_plane_ipv4[each.value.index].ip_address

  depends_on = [hcloud_server.control_planes]
}

resource "talos_machine_configuration_apply" "worker" {
  for_each = local.workers

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.worker.machine_configuration
  node                        = hcloud_primary_ip.worker_ipv4[each.value.index].ip_address
  endpoint                    = hcloud_primary_ip.worker_ipv4[each.value.index].ip_address

  depends_on = [hcloud_server.workers]
}

resource "talos_machine_configuration_apply" "node_pool" {
  for_each = local.node_pool_servers

  client_configuration        = talos_machine_secrets.this.client_configuration
  machine_configuration_input = data.talos_machine_configuration.node_pool[each.value.pool].machine_configuration
  node                        = hcloud_primary_ip.node_pool_ipv4[each.key].ip_address
  endpoint                    = hcloud_primary_ip.node_pool_ipv4[each.key].ip_address

  depends_on = [hcloud_server.node_pools]
}

# Bootstrap etcd exactly once, on the first control plane.
resource "talos_machine_bootstrap" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = local.control_plane_public_ip
  endpoint             = local.control_plane_public_ip

  depends_on = [talos_machine_configuration_apply.control_plane]
}

resource "talos_cluster_kubeconfig" "this" {
  client_configuration = talos_machine_secrets.this.client_configuration
  node                 = local.control_plane_public_ip
  endpoint             = local.control_plane_public_ip

  depends_on = [talos_machine_bootstrap.this]
}

# ── The node-pool contract's render (#5533), copied UNCHANGED from
#    packages/core/cloud/testdata/nodepool/reference/render.tf. It lives in this file (not a file of
#    its own) because apps/console/scripts/gen-template-knobs.mjs attributes a root variable to a
#    component by the file that reads it, and talos.tf is the cluster's: in a file of its own,
#    node_labels and node_taints would be read by nothing the generator attributes, and could not be
#    offered on the cluster card. The Talos patches above build every pool's labels and taints FROM
#    local.nodepool_contract_render, and nodepool_contract.tftest.hcl asserts its output.

locals {
  nodepool_contract_render = merge(
    {
      default = {
        labels = var.node_labels
        taints = []
      }
    },
    {
      for p in var.extra_node_pools : p.name => {
        labels = merge(var.node_labels, p.labels, { "alethia.io/pool" = p.name })
        taints = concat(
          [
            for t in var.node_taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }
            if !contains([for pt in p.taints : "${pt.key}:${pt.effect}"], "${t.key}:${t.effect}")
          ],
          [for t in p.taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }],
          p.arch == "arm64" ? [{ key = "alethia.io/arch", value = "arm64", effect = "NoSchedule" }] : [],
        )
      }
    },
  )
}

output "nodepool_contract_render" {
  description = "Per pool (the default pool under `default`), the labels and taints its nodes carry under the node-pool contract (#5533)."
  value       = local.nodepool_contract_render
}
