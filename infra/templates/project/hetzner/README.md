<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Talos Kubernetes on Hetzner Cloud

Minimal, self-managed [Talos Linux](https://www.talos.dev/) Kubernetes cluster on
Hetzner Cloud: a single control plane + N workers, on the cheapest arm64 path by
default. Modeled on
[hcloud-talos/terraform-hcloud-talos](https://github.com/hcloud-talos/terraform-hcloud-talos).

The runner copies this template verbatim, feeds it a `.tfvars.json`, then runs
`tofu init` (partial S3 backend) → `plan` → `apply`.

## How it works

1. **Image (in-apply):** a Talos [Image Factory](https://factory.talos.dev/)
   schematic is built with the `siderolabs/qemu-guest-agent` extension; the
   `hcloud` disk image (`raw.xz`) URL is derived per architecture and uploaded +
   snapshotted into Hetzner via the `hcloud-talos/imager` provider
   (`imager_image`). Only the architecture(s) actually referenced by
   `control_plane_arch` / `worker_arch` are built.
2. **Network:** one `hcloud_network` + `/24` node subnet carved from
   `network_cidr`, plus a firewall allowing Talos apid (50000/50001), the
   Kubernetes API (6443), and all intra-cluster traffic.
3. **Bootstrap:** `talos_machine_secrets` → `talos_machine_configuration`
   (controlplane + worker, patched to disable the default CNI + kube-proxy and
   set the pod/service CIDRs + install disk) → `talos_machine_configuration_apply`
   per node → `talos_machine_bootstrap` → `talos_cluster_kubeconfig`.
4. **CNI + cloud integration:** [Cilium](https://cilium.io/) in
   kube-proxy-replacement / native-routing mode, the
   [hcloud cloud-controller-manager](https://github.com/hetznercloud/hcloud-cloud-controller-manager),
   and the [hcloud CSI driver](https://github.com/hetznercloud/csi-driver) — all
   rendered offline from their Helm charts (`helm_template` data sources) and
   exported via the `bootstrap_manifests` output — the runner applies them with
   `kubectl` **after** apply (Talos ships CNI=none, so nodes stay NotReady until
   then). They are deliberately NOT embedded as Talos `cluster.inlineManifests`:
   the machine config rides in Hetzner cloud-init `user_data` (32 KiB cap) and
   Cilium's rendered manifest alone busts it; post-apply also matches how the
   managed clouds do their post-cluster work. There is deliberately **no in-tofu
   `kubectl` provider** wired from the cluster's own (known-after-apply) kubeconfig
   — that made `tofu plan -out` (the runner's path) unresolvable, so the runner
   could never deploy this template.

## Verification

`tofu validate` checks the configuration; a **real `tofu apply` is the true
verification step** and **requires `HCLOUD_TOKEN`** in the environment (the
`hcloud` and `imager` providers read it from there — there is no token
variable). Agents must never run `tofu plan` / `tofu apply`.

## Inputs

| Variable | Default | Description |
| --- | --- | --- |
| `project_name` | _(required)_ | Combined with `environment` into the cluster name. |
| `environment` | _(required)_ | Environment name (dev/staging/prod). |
| `region` | `fsn1` | Hetzner location. |
| `talos_version` | `v1.9.5` | Talos Linux version. |
| `kubernetes_version` | `""` | Kubernetes version; empty → Talos default. |
| `control_plane_count` | `1` | Number of control-plane nodes. |
| `control_plane_server_type` | `cax11` | CP server type. |
| `control_plane_arch` | `arm64` | CP arch (`arm64` for cax*, `amd64` for cx*). |
| `worker_count` | `1` | Number of worker nodes. |
| `worker_server_type` | `cax11` | Worker server type. |
| `worker_arch` | `arm64` | Worker arch. |
| `network_cidr` | `10.0.0.0/16` | Private network CIDR. |
| `pod_cidr` | `10.244.0.0/16` | Cilium pod CIDR (must not overlap the others). |
| `service_cidr` | `10.96.0.0/12` | Service CIDR (must not overlap the others). |
| `hcloud_token` | `""` | Optional; **only** for the in-cluster hcloud CCM secret. The providers use `HCLOUD_TOKEN` from the env. May be supplied via `TF_VAR_hcloud_token`. |

## Outputs

| Output | Description |
| --- | --- |
| `talos_cluster_name` | `project_name-environment` (non-empty; gates kubeconfig setup). |
| `talos_cluster_endpoint` | `https://<control-plane-ip>:6443`. |
| `kubeconfig` (sensitive) | Raw kubeconfig. |
| `talosconfig` (sensitive) | Talos client configuration. |

## Notes / limits

- Single control plane uses the CP's **public IP** as the API endpoint. For HA
  (`control_plane_count > 1`) add a floating-IP VIP — documented upgrade, not
  wired here to keep the minimal path cheap.
- `install.disk` is pinned to `/dev/sda` (correct for Hetzner Cloud VMs).
