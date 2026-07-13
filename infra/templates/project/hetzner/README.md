<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Talos Kubernetes on Hetzner Cloud

Minimal, self-managed [Talos Linux](https://www.talos.dev/) Kubernetes cluster on
Hetzner Cloud: a single control plane + N workers, on a cheap, currently-orderable
amd64 shared-vCPU path by default (`cpx22`; override to `cax*` for ARM when capacity
permits). Modeled on
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
| `control_plane_server_type` | `cpx22` | CP server type (2 vCPU / 4 GB, amd64; orderable). `cax11` ARM is capacity-unreliable, `cpx11` retired. |
| `control_plane_arch` | `amd64` | CP arch (`arm64` for cax*, `amd64` for cx*/cpx*/ccx*). |
| `worker_count` | `1` | Number of worker nodes. |
| `worker_server_type` | `cpx22` | Worker server type (2 vCPU / 4 GB, amd64; orderable). |
| `worker_arch` | `amd64` | Worker arch. |
| `network_cidr` | `10.0.0.0/16` | Private network CIDR. |
| `pod_cidr` | `10.0.128.0/17` | Cilium pod CIDR. Must be a **subnet** of `network_cidr` (native routing) and not overlap the service/node subnets. |
| `service_cidr` | `10.0.96.0/19` | Service CIDR. Must be a **subnet** of `network_cidr` and not overlap the pod/node subnets. |
| `hcloud_token` | `""` | Optional; **only** for the in-cluster hcloud CCM secret. The providers use `HCLOUD_TOKEN` from the env. May be supplied via `TF_VAR_hcloud_token`. |
| `buckets` | `[]` | Object Storage buckets (see below). Empty → the minio provider is never exercised. |
| `hetzner_s3_endpoint` | `fsn1.your-objectstorage.com` | S3 endpoint **host** (no scheme). Only used when `buckets` is non-empty. |
| `hetzner_s3_region` | `fsn1` | Object Storage location (`fsn1`/`nbg1`/`hel1`). |
| `hetzner_s3_access_key` (sensitive) | `""` | S3 access key (see Object Storage note). |
| `hetzner_s3_secret_key` (sensitive) | `""` | S3 secret key. |

## Object Storage (S3-compatible buckets) — `buckets.tf`

Hetzner Object Storage is a **separate product** from the Hetzner Cloud API: it speaks the
S3 API at `https://<location>.your-objectstorage.com` and authenticates with an S3
access-key/secret-key pair — **not** the Cloud API token. There is **no API to mint** those
keys; the customer generates them by hand in the Hetzner Console (Object Storage → your
bucket location → S3 credentials). Alethia stores them encrypted and exports them to the
runner as `HETZNER_S3_ACCESS_KEY` / `HETZNER_S3_SECRET_KEY` (→ `TF_VAR_hetzner_s3_*`).

Buckets are provisioned with the Hetzner-docs-endorsed [`aminueza/minio`](https://registry.terraform.io/providers/aminueza/minio)
provider (`~> 3.3`) in `s3_compat_mode`. Each `buckets` entry:

| Field | Effect on Hetzner |
| --- | --- |
| `name` | Bucket name (namespaced `project-environment-<name>`). |
| `versioning` | Enabled via `minio_s3_bucket_versioning` when `true`. |
| `public_access` | `true` → `public-read` ACL, else `private`. |
| `encryption_enabled` | **Informational** — Hetzner encrypts at rest automatically; no per-bucket toggle. |
| `cors_origins` | **Ignored** — the provider does not apply CORS to a non-MinIO backend (`s3_compat_mode` skips it). |

Object Storage exists only in `fsn1`/`nbg1`/`hel1`; a cluster in a compute-only region
(ash/hil/sin) falls back to `fsn1` for buckets.

## Outputs

| Output | Description |
| --- | --- |
| `talos_cluster_name` | `project_name-environment` (non-empty; gates kubeconfig setup). |
| `talos_cluster_endpoint` | `https://<control-plane-ip>:6443`. |
| `kubeconfig` (sensitive) | Raw kubeconfig. |
| `talosconfig` (sensitive) | Talos client configuration. |
| `bucket_names` | Provisioned Object Storage bucket names (empty when none). |
| `bucket_endpoints` | Per-bucket S3 URLs (`https://<endpoint>/<bucket>`). |

## Notes / limits

- Single control plane uses the CP's **public IP** as the API endpoint. For HA
  (`control_plane_count > 1`) add a floating-IP VIP — documented upgrade, not
  wired here to keep the minimal path cheap.
- `install.disk` is pinned to `/dev/sda` (correct for Hetzner Cloud VMs).
