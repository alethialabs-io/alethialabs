# Alethia — Competitive Deep-Dives

Sourced, head-to-head comparisons of **Alethia** vs every relevant competitor. Each file follows the same template (snapshot · how it works · pricing · ownership/security · head-to-head table · where Alethia wins · **where they win** · positioning · sources). This README is the master matrix.

**The frame:** Alethia is an open-source (AGPL), self-hostable, **zero-trust** platform that provisions a complete production cluster in *your* cloud, wires ArgoCD to *your* repo, and hands you a cluster you **own** — "own the real thing vs rent a black box." See [01-product-vision](../01-product-vision.md) · [03-competitive-positioning](../03-competitive-positioning.md).

> **The honest pattern across all 14:** Alethia wins on **ownership, openness (AGPL), zero-trust (never stores cloud creds)**, and — versus the PaaS — **provisioning real cloud-native infra you own**. But **nearly every competitor is more mature today**, shipping **day-2 ops** (logs, rollbacks, preview envs, autoscaling) — which is precisely **Alethia's V2 ("Provision & Operate")**. Strategy: win on the structural moat now (own-it + zero-trust + open-source); close the day-2 gap in V2.

## Master matrix

| Competitor | Category | Self-host control plane | Zero stored creds | Provisions real cloud infra | App-delivery | Multi-cloud | Open source | Pricing floor |
|---|---|---|---|---|---|---|---|---|
| **Alethia** | **(us)** | **✅ AGPL, ~4 containers** | **✅ runtime roles** | **✅ EKS + managed services** | **✅ GitOps → your repo** | **✅ AWS now; +more** | **✅ AGPL + ee/** | **free self-host** |
| [Porter](porter.md) | BYOC PaaS | ❌ SaaS | ◐ AWS/GCP only | ✅ your account | proprietary | ✅ AWS/GCP/Azure | ❌ | usage; no free |
| [Qovery](qovery.md) | BYOC PaaS | ◐ Enterprise only | ◐ partial | ✅ | proprietary engine (GPL) | ✅ broad +BYO | ◐ engine GPL | $899/mo |
| [Northflank](northflank.md) | BYOC/hosted | ◐ Enterprise only | ❌ | ✅ BYOC | proprietary | ✅ very broad | ❌ | usage; free sandbox |
| [Azin](azin-run.md) | BYOC PaaS | ❌ SaaS | ? unverified | ✅ your GCP | proprietary | ❌ GCP only | ❌ | €0 / €20 / €100 |
| [Terraform Cloud](terraform-cloud.md) | IaC orchestration | ◐ TFE (paid) | ◐ OIDC option | ❌ orchestrates HCL | infra CI/CD | ✅ any provider | ❌ BUSL | per-resource; free ≤500 |
| [Spacelift](spacelift.md) | IaC orchestration | ◐ Enterprise+ | ✅ parity | ❌ orchestrates IaC | IaC runs | ✅ broad | ❌ (worker only) | $399/mo |
| [Crossplane](crossplane.md) | Control plane | ✅ in your cluster | ✅ OSS | ◐ engine only (BYO) | none (BYO GitOps) | ✅ broad | ✅ Apache (CNCF) | OSS free; Upbound $1k/mo |
| [Cloudfleet](cloudfleet.md) | Managed k8s | ❌ SaaS | ◐ mostly | ◐ cluster only | plain kubectl | ✅ AWS/GCP/Hetzner/edge | ❌ | free ≤24 vCPU |
| [Syself](syself.md) | Managed k8s | ◐ paid Dedicated | ❌ holds token | ◐ managed k8s | GitOps (BYO) | ❌ Hetzner only | ◐ CAPH Apache | free 1 cluster; €299/mo |
| [Coolify](coolify.md) | Self-host PaaS | ✅ Apache-2.0 | ❌ SSH keys | ❌ VPS containers | proprietary | ◐ any VPS (no cloud) | ✅ Apache-2.0 | free self-host |
| [Dokploy](dokploy.md) | Self-host PaaS | ✅ Apache-2.0 | ❌ SSH keys | ❌ Swarm on VPS | proprietary | ◐ any VPS | ✅ Apache (open-core) | free self-host |
| [Sealos](sealos.md) | Cloud-OS PaaS | ✅ source-available | n/a | ❌ own k8s, not cloud | proprietary | ◐ own cluster | ◐ source-available | $7–$2030/mo |
| [Render](render.md) | Hosted PaaS | ❌ | n/a (their infra) | ❌ their clusters | proprietary | ❌ | ❌ | Hobby free; Pro $25 |
| [Railway](railway.md) | Hosted PaaS | ❌ | n/a | ❌ their metal | proprietary | ❌ | ❌ | $5 Hobby; $20/seat |

Legend: ✅ yes · ◐ partial/conditional · ❌ no · ? unverified · n/a not applicable.

## Strategic takeaways

- **The PaaS (Porter / Qovery / Northflank / Azin / Render / Railway)** hold your keys and/or run your control plane and lock deploys into a proprietary pipeline. Alethia's wedge: own the cluster + standard GitOps + zero-trust. They win on day-2 maturity.
- **The IaC tools (Terraform Cloud / Spacelift)** orchestrate HCL you must still write — no finished cluster, no app delivery. Alethia hands you the running thing.
- **Crossplane** is the closest on openness + self-host, but it's an *engine + blank page* needing a platform team to author Compositions and wire GitOps. Alethia is the finished product on top.
- **Managed k8s (Cloudfleet / Syself)** give you a cluster but hold keys / aren't multi-cloud / don't wire GitOps to your repo or provision the surrounding data stack.
- **Self-hosted PaaS (Coolify / Dokploy / Sealos)** nail "own it" + DX but deploy **containers to VPS** — no real cloud-native k8s + managed services. Alethia is "own it" *with* real cloud infrastructure.
- **Universal gap to close:** day-2 ops (= V2). **Universal moat to hold:** ownership + zero-trust + AGPL.
