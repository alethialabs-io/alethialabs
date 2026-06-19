# 09 — Multi-Cloud & Cluster Strategies

**Status:** Accepted (architecture). Map **many** cloud providers and let the user choose; support both **managed** and **self-managed** clusters. Talos/Hetzner is *one optional strategy*, not the headline.

## The two axes

| Axis | What it picks | Examples |
|---|---|---|
| **CloudProvider** | the infra substrate (compute, network, identity, storage) | aws · gcp · azure · **hetzner · scaleway · ovh · digitalocean · …** |
| **ClusterStrategy** | how Kubernetes is created on that substrate | **managed** (EKS/GKE/AKS) · **self-managed** (Talos / k3s) |

A cluster = `(CloudProvider, ClusterStrategy)`. Managed strategies use the cloud's k8s API; self-managed strategies provision nodes + bootstrap k8s themselves.

## Where it plugs in today (the single-source-of-truth problem)

The provider set is **hand-maintained in ~4 places** — adding one means editing all four:
- `packages/core/cloud/provider.go` — `NewCloudProvider` switch (`aws/gcp/azure`) + `ExtractClusterName/Endpoint` keyed to `eks_/gke_/aks_`.
- `apps/alethia/lib/cloud-providers/registry.ts` — `CloudProviderSlug = "aws"|"gcp"|"azure"`.
- `infra/templates/spec/{aws,gcp,azure}/` — per-provider OpenTofu modules.
- The runner's provider switch (`apps/runner/runner/runner.go`).

**Fix:** declare the provider set **once** (a registry that emits both the Go switch and the TS union, e.g. via codegen) so "supported providers" lives in one place. New providers and the [08](08-integrations-extensibility.md) category providers share this discipline.

## Adding a CloudProvider — the checklist

1. Implement the `CloudProvider` interface in `core` (credentials, region metadata, `Tfvars`, kubeconfig retrieval).
2. Register it in the single source of truth (→ Go switch + TS union update automatically).
3. Add OpenTofu modules under `infra/templates/spec/<provider>/` (network + compute + the chosen ClusterStrategy).
4. Add the catalog row + credential mapping ([08](08-integrations-extensibility.md)).
5. Add the runner credential path (e.g. an API token for token-auth clouds; AssumeRole/WIF/federated for hyperscalers).

## ClusterStrategy: managed vs self-managed

- **Managed** (today): the cloud runs the control plane; kubeconfig comes from its API/CLI; outputs carry a managed endpoint. EKS/GKE/AKS. Lowest day-2 burden.
- **Self-managed** (new, optional): **Talos** (immutable, API-driven, no SSH) or **k3s** on the provider's compute. You now own node provisioning, control-plane HA/etcd, CNI (Cilium), CCM/CSI, load balancers, kubeconfig (via `talosctl`/the Talos OpenTofu provider, not a cloud API), and upgrades. Best fit where there is no managed k8s (e.g. Hetzner) or where cost/sovereignty motivates it.

The abstraction must therefore **decouple "infra provider" from "cluster strategy"**: `CloudProvider` handles substrate; a `ClusterStrategy` interface owns the cluster endpoint, kubeconfig retrieval, and post-provision bootstrap. A self-managed cluster = `CloudProvider=<x>` + `ClusterStrategy=talos`. This keeps EKS/GKE/AKS as `managed` and isolates the Talos lifecycle.

## Provider breadth — priority

AWS (active) → GCP/Azure (finish onboarding) → then breadth: **Hetzner, DigitalOcean, Scaleway, OVH** (and self-managed strategies where managed k8s is absent). No bet on a single cloud or a single distro — breadth + user choice is the point.

## Risks

- Self-managed clusters add real day-2 surface (etcd HA, upgrades, CCM/CSI) — gate behind the strategy interface and ship managed first.
- Provider drift across the 4 hand-maintained sites — the single-source-of-truth fix is a prerequisite for adding any new provider.

## Exit criteria

- Adding a new CloudProvider touches **one** registry (not four) + its templates.
- A Spec can target a managed cluster (EKS) **or** a self-managed Talos cluster (e.g. on Hetzner) through the same `(CloudProvider, ClusterStrategy)` selection.
