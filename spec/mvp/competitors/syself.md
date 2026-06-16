# Alethia vs Syself

## Snapshot

Syself is a managed Kubernetes platform for **Hetzner only** (cloud, bare metal, and GPU),
built on upstream **Cluster API** plus Syself's own **Cluster API Provider Hetzner (CAPH)**
and **Cluster Stacks**. Its commercial product, **Autopilot**, runs a Syself-managed
management cluster ("control plane") that drives day-2 operations — self-healing, upgrades,
HA. The CAPH provider is open source (Apache-2.0); the Autopilot platform is proprietary.
It is mature (production at scale, well-known in the CAPI community) but single-cloud and
not opinionated about app delivery (bring your own ArgoCD/Flux).

Alethia is an **open-source (AGPL), self-hostable, multi-cloud, zero-trust** platform. One
Spec → a remote worker provisions a **complete production cluster** in the user's *own*
cloud (EKS + Aurora + ElastiCache + DynamoDB + ECR + S3 + Secrets Manager + Route53 + WAF),
installs **ArgoCD wired to the user's Git repo** (git push → deploy), and hands back a
cluster the user owns. The Alethia control plane **never stores cloud credentials** — the
worker assumes roles at runtime.

> Note: Syself was part of an earlier "EU-sovereign Hetzner" framing that has since been
> demoted. Today Alethia's edge is multi-cloud breadth + AWS managed-service depth +
> zero-trust + full self-host + auto-wired GitOps — not sovereignty.

## How it works

Syself layers Autopilot on top of Cluster API. A **Cluster Stack** is a versioned, tested
bundle (Kubernetes version, CNI, CSI, OS image, add-ons) — "a Dockerfile for your cluster" —
giving 100% reproducible, immutable clusters. A **management cluster** is the central point
that holds the CAPI custom resources and reconciles workload clusters; the Cluster Stack
Operator keeps both management and workload clusters at their declared versions. Upgrades
are a one-line stack-version bump that Syself orchestrates incrementally along validated
paths. CAPH talks to the Hetzner Cloud/Robot APIs to create servers, then self-heals
infrastructure drift. App delivery is **GitOps-compatible (BYO ArgoCD/Flux)** — there is no
proprietary push-to-deploy pipeline and ArgoCD is not pre-wired to a customer repo.

## Pricing

- **Free** — €0, "free forever": **1 cluster, up to 5 nodes**, community support.
- **Paid** — from **€299/mo** base platform fee + a **percentage of cloud spend** (varies by
  provider/plan); unlimited clusters and nodes, standard support, **14-day free trial**.
- **Dedicated Hosting** — paid add-on to "host Syself Autopilot on your own servers"
  (self-run management plane).
- **Premium support** — purchased separately.

(Exact cloud-spend percentages are not published; quoted figures are from syself.com/pricing.)

## Ownership & security model

By default, **Autopilot's management cluster is hosted/managed by Syself**. The user's
**Hetzner API token (read+write)** lives as a Kubernetes secret in that management cluster,
and a Robot user + SSH keys are added for bare metal — so in the default tier Syself's plane
holds the keys that can create and destroy Hetzner infrastructure. The CAPH provider is
**Apache-2.0 open source** and self-installable on your own CAPI setup, but the **Autopilot
platform (Cluster Stacks operator, automation, UI) is proprietary**. Running the plane
yourself requires the **paid Dedicated Hosting tier**.

Alethia inverts this: the control plane **never** stores cloud credentials (the worker
assumes a role at runtime), the **entire control plane is AGPL and self-hostable as ~4
containers**, and the provisioned cluster lives entirely in the user's account from day one.

## Alethia vs Syself

| Capability | Alethia | Syself |
|---|---|---|
| Multi-cloud | Yes (AWS today; GCP/Azure templates) | **No — Hetzner only** (cloud + bare metal + GPU) |
| Own / self-host control plane | Yes — AGPL, ~4 containers, free | Only via **paid** Dedicated tier; default plane is Syself-hosted |
| Zero stored cloud credentials | Yes — worker assumes role at runtime | No — Hetzner token stored as secret in mgmt cluster |
| Provisions managed data services | Yes (Aurora, ElastiCache, DynamoDB, S3, Secrets Mgr, Route53, WAF) | No — k8s nodes only; you run data services yourself |
| GitOps wired to *your* repo | Yes — ArgoCD auto-wired, git push → deploy | No — BYO ArgoCD/Flux, GitOps-compatible but not pre-wired |
| Open source | Core AGPL + `ee/` (open-core) | CAPH Apache-2.0; Autopilot platform proprietary |
| Pricing | OSS / self-host | Free (1 cluster ≤5 nodes); paid from €299/mo + % cloud spend |
| Day-2 maturity | Early (V1 "Provision & Own") | **Mature** — self-healing, upgrades, HA, prod at scale |

## Where Alethia wins

- **Multi-cloud + AWS managed-service breadth.** Syself is Hetzner-only and provisions
  compute nodes; Alethia stands up EKS *and* the full managed-service stack (Aurora,
  ElastiCache, DynamoDB, ECR, S3, Secrets Manager, Route53, WAF) in the user's account.
- **Zero-trust, never stores credentials.** The Alethia control plane never holds cloud
  keys; Syself's default management cluster stores your Hetzner token.
- **Fully self-hostable, AGPL control plane** as ~4 containers — no paid tier required to
  own the plane, unlike Syself's Dedicated add-on.
- **Auto-wired GitOps you control.** ArgoCD is pre-wired to the user's repo for git-push
  deploys; Syself leaves app delivery as BYO.

## Where Syself wins

- **Maturity** — 5+ years, production at scale, CII Best Practices, strong standing in the
  Cluster API community.
- **Real managed day-2 ops** — self-healing, safe incremental upgrades, HA control planes,
  continuous reconciliation. Alethia V1 is "Provision & Own"; managed operations are V2.
- **Bare metal + GPU** on Hetzner — Alethia targets cloud managed services, not bare metal.
- **Hetzner cost economics** — dramatically cheaper compute than AWS for many workloads.
- **Staffed support** (standard + premium) and **CAPI pedigree** — upstream-aligned,
  government/community-backed Cluster API standards.

## How to position

Syself = **managed Kubernetes ops on Hetzner** — great if you want cheap Hetzner compute,
bare metal/GPU, and someone else to run upgrades and HA, and you accept a single cloud and
a vendor-held control plane. Alethia = **own your multi-cloud production infrastructure**,
with zero-trust (no stored credentials), a fully self-hostable AGPL control plane, the
full managed-data-service stack in your account, and portable GitOps wired to *your* repo.
Anti-Porter framing: don't rent a black box — own the real thing, in your cloud, on your Git.

## Sources

- https://syself.com/ — Syself platform overview
- https://syself.com/hetzner — Managed Kubernetes on Hetzner (cloud + bare metal + GPU)
- https://syself.com/pricing — Free / paid (€299/mo + % cloud spend) / Dedicated Hosting tiers
- https://syself.com/docs/hetzner/apalla/getting-started/introduction-to-syself-autopilot — Autopilot architecture, management cluster
- https://syself.com/docs/hetzner/apalla/getting-started/hetzner-account-preparation — Hetzner API token stored as secret in management cluster
- https://syself.com/docs/hetzner/apalla/concepts/cluster-stacks — Cluster Stacks ("Dockerfile for your cluster"), upgrades, GitOps compatibility
- https://syself.com/news/syself-introduces-mvp-cluster-stacks — Cluster Stacks announcement
- https://github.com/syself/cluster-api-provider-hetzner — CAPH provider, Apache-2.0, self-healing, CII Best Practices
- https://community.hetzner.com/tutorials/kubernetes-on-hetzner-with-cluster-api/ — CAPI on Hetzner background
