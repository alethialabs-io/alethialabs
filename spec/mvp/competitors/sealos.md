# Alethia vs Sealos

## Snapshot
Sealos is an "AI-native Cloud Operating System" built on Kubernetes — a hosted PaaS plus a
source-available k8s distribution. One-click app deploys, managed databases, a cloud IDE (DevBox),
S3-compatible storage, and multi-tenant workspaces, all running on its own Kubernetes layer.
- **Category:** cloud-OS / Kubernetes PaaS (Heroku/Render-style abstraction over k8s).
- **Company:** labring / Sealos, founded 2022, HQ Hangzhou, China; ~$5M raised through Series B-II;
  investors include Alibaba Cloud, MiraclePlus, YF Investment. ~18k GitHub stars; v5.1.1 (Nov 2025).
- **Business model:** Hosted multi-tenant SaaS (subscription tiers) at os.sealos.io, plus a
  self-hostable build for enterprises and custom contracts.

## How it works
- **Where it runs:** The flagship product is a **hosted SaaS in Sealos' own cloud** — you sign up,
  fund a wallet / pick a tier, and run workloads on their multi-tenant clusters. The **full cloud OS
  is also self-hostable** on a Kubernetes cluster you provide (master ~2c/2G, a public domain or
  free `nip.io` wildcard, TLS via cert-manager). This self-host story is real and well-documented.
- **What it provisions vs deploys:** Sealos does **not** orchestrate native cloud managed services in
  your AWS/GCP account. It runs everything *inside a Sealos Kubernetes cluster*: managed databases
  (PostgreSQL/MySQL/MongoDB/Redis via KubeBlocks), S3-compatible object storage, CronJobs, DevBox
  cloud IDEs, and an App Store of 100+ templates.
- **Deploy mechanism:** App Launchpad — **point-click / container image / app-store templates**. It is
  **not Git/GitOps/ArgoCD-native**; there is no built-in "wire ArgoCD to your repo, push-to-deploy"
  flow. The k8s installer (`sealos run`) handles cluster lifecycle (install, upgrade, backup) from
  OCI-packaged cluster images.
- **Kubernetes managed:** Sealos *is* the Kubernetes (its own distro), not a layer that hands you an
  EKS/GKE/AKS cluster you own under your cloud account.

## Pricing
As of 2026 (https://sealos.io/pricing/):
- **Free trial:** 7 days, no credit card — 4 vCPU / 4 GB RAM / 5 GB volume / 500 MB bandwidth / 100 AI credits.
- **Starter:** $7/mo (2 vCPU / 2 Gi / 10 Gi storage).
- **Hobby:** $25/mo (4 vCPU / 4 Gi / 20 Gi).
- **Standard:** $128/mo (8 vCPU / 16 Gi / 50 Gi).
- **Pro:** $512/mo (16 vCPU / 32 Gi / 200 Gi).
- **Team:** $2,030/mo (64 vCPU / 128 Gi / 500 Gi).
- **Enterprise:** "Custom Contracts." Self-hosting the platform on your own hardware avoids these tiers
  but is licensed under the Sustainable Use License (below). Historically Sealos used a pay-as-you-go
  prepaid wallet; the public plans are now tier-based.

## Ownership & security model
- **Cloud credentials:** Not applicable in the zero-trust sense. The hosted product runs in *Sealos'*
  cloud; the self-hosted product runs in *your* cluster but you install and operate it yourself. There
  is **no remote-worker-assumes-a-role model** and the control plane does not broker into your AWS
  account using native IAM roles — because it doesn't provision native cloud services at all.
- **Self-host the control plane:** **Yes** — and this is Sealos' strongest parallel to Alethia. The
  entire cloud OS can be installed on your own Kubernetes. Genuinely better day-1 self-host maturity
  than V1 Alethia.
- **Deploy pipeline portability:** App Launchpad / templates are a **proprietary abstraction**. You can
  drop to "raw Kubernetes," but the deploy UX, app store, and DB operators are Sealos-specific, not
  standard ArgoCD/Kustomize wired to your git repo.
- **Open source:** **Source-available, not OSI open source.** The repo uses a **Sustainable Use
  License** that permits internal/non-commercial use but **prohibits offering Sealos as a service to
  third parties** (some components, like the installer, are Apache-2.0). This is materially more
  restrictive than Alethia's AGPL core.
- **Lock-in:** Moderate. The DB/app abstractions and Sealos-specific operators create switching cost,
  and for the hosted tier your data lives in Sealos' (China-HQ) cloud — a sovereignty consideration
  for some Western buyers.

## Alethia vs Sealos
| Capability | Alethia | Sealos |
| --- | --- | --- |
| Own / self-host the control plane | Yes — ~4 containers, AGPL | Yes — full cloud OS on your k8s (Sustainable Use License) |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime | N/A — no native-cloud brokering; runs in Sealos/own cluster |
| App-delivery model | Real ArgoCD wired to your git repo (GitOps) | Click / container image / app-store templates (proprietary) |
| Self-host the platform | Yes (AGPL core + commercial ee) | Yes (source-available, no-3rd-party-SaaS clause) |
| Multi-cloud | EKS now; GKE/AKS + Talos/k3s roadmap, native managed services | k8s installer runs anywhere, but builds a Sealos cluster, not native services |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub | App Store of 100+ templates; AI Proxy; KubeBlocks DBs |
| Open source | AGPL (true OSI) | Source-available (Sustainable Use License) |
| Pricing model | Open core; self-host free | Tiered SaaS $7–$2,030/mo + enterprise; self-host build |
| Day-2 ops | Thin dashboard now; native console roadmap (V2) | Mature: web console, DevBox IDE, monitoring, backups, scaling |

## Where Alethia wins
- **You own native cloud primitives.** Alethia hands you a real EKS cluster + Aurora/ElastiCache/SQS/etc.
  *in your own AWS account*; Sealos workloads live inside a Sealos k8s cluster you don't natively own.
- **True zero-trust BYOC.** The worker assumes a role at runtime and the control plane never stores
  cloud creds — Sealos has no equivalent; hosted Sealos holds everything, self-hosted Sealos has no
  cross-account model.
- **Real GitOps, not a black box.** ArgoCD wired to your git repo with push-to-deploy and standard
  Kustomize/Helm — fully portable. Sealos deploys via a proprietary click/template flow.
- **Genuinely open source (AGPL).** Sealos is source-available with a clause barring service resale;
  Alethia's AGPL core is OSI-licensed and unrestricted for internal/commercial use.
- **Data sovereignty.** AGPL self-host in your own Western cloud account vs a China-HQ hosted vendor —
  a real factor for regulated/EU buyers.

## Where Sealos wins
- **Maturity & traction.** 3+ years, v5, ~18k stars, real funding and an Alibaba Cloud backer — far
  more battle-tested than V1 Alethia.
- **Self-host is proven today.** The complete cloud OS already self-hosts cleanly; Alethia's
  self-host-the-control-plane story is newer.
- **Breadth of built-in product.** DevBox cloud IDE, App Store of 100+ templates, KubeBlocks managed
  DBs, object storage, CronJobs, AI Proxy — a wide menu Alethia doesn't yet match.
- **Day-2 DX now.** Web console, monitoring, autoscaling, backups, and multi-tenant workspaces ship
  today; Alethia's native day-2 console is a V2 roadmap item.
- **Lower entry price.** $7/mo starter and a true free trial undercut anything requiring a full cloud
  account.

## How to position against them
"Sealos is a slick cloud-OS, but your apps live inside *Sealos'* Kubernetes abstraction and deploy
through *their* proprietary click-flow under a source-available license. Alethia provisions a real EKS
cluster plus native AWS managed services **in your own account**, wires standard ArgoCD to **your git
repo**, and is true AGPL — same speed to production, but you own the actual cloud, the GitOps pipeline,
and the control plane, with zero stored credentials."

## Sources
- https://sealos.io/docs/overview/about-sealos
- https://sealos.io/blog/what-is-sealos/
- https://sealos.io/pricing/
- https://github.com/labring/sealos
- https://sealos.io/docs/self-hosting/sealos/installation
- https://www.crunchbase.com/organization/sealos
- https://www.cbinsights.com/company/sealos
