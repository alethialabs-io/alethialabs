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
        podSubnets     = [var.pod_cidr]
        serviceSubnets = [var.service_cidr]
      }
      proxy = {
        disabled = true
      }
    }
  }

  # The `hcloud` Secret (token + private-network id) that the CCM + CSI read.
  hcloud_secret_manifest = yamlencode({
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

  # Control-plane cluster patch = base + Talos `inlineManifests`. Talos applies these
  # during bootstrap (before it reports the cluster up), so CNI + cloud integration come
  # up with no in-tofu kubectl provider wired from the cluster's own kubeconfig — which is
  # what let `tofu plan -out` (the runner's path) fail before. The manifests are rendered
  # offline by the `helm_template` data sources (cilium.tf / csi.tf); order matters: the
  # Secret first, then Cilium (CNI), then the CCM + CSI which consume it.
  cluster_patch_cp = {
    cluster = merge(local.cluster_patch.cluster, {
      inlineManifests = [
        { name = "hcloud-secret", contents = local.hcloud_secret_manifest },
        { name = "cilium", contents = data.helm_template.cilium.manifest },
        { name = "hcloud-ccm", contents = data.helm_template.hcloud_ccm.manifest },
        { name = "hcloud-csi", contents = data.helm_template.hcloud_csi.manifest },
      ]
    })
  }

  control_plane_patches = [yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch_cp)]
  worker_patches        = [yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch)]
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
