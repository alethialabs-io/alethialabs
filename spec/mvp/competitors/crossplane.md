# Alethia vs Crossplane

## Snapshot
Crossplane is an open-source **control-plane framework for platform engineering** — it extends Kubernetes so you can build your own declarative cloud APIs and provision/reconcile any infrastructure (databases, networks, IAM, even SaaS) from `kubectl`. It is a CNCF project (Apache 2.0), originally created by **Upbound** and **graduated by CNCF in Nov 2025** — 3,000+ contributors, 450+ orgs, used by Nike, SAP, Autodesk, NASA, IBM. ([crossplane.io](https://www.crossplane.io/), [CNCF graduation](https://www.cncf.io/announcements/2025/11/06/cloud-native-computing-foundation-announces-graduation-of-crossplane/))
- **Business model**: The project is free OSS. Commercialization is via **Upbound** (the company): a managed/self-hosted control-plane SaaS ("Spaces"), enterprise distribution (UXP), and support. Upbound raised a **$60M Series B in 2021** (led by Altimeter; GV, Intel Capital), ~$69M total. ([TechCrunch](https://techcrunch.com/2021/11/29/upbound-grabs-60m-series-b-to-grow-open-source-crossplane-cloud-management-project/))
- **Important framing**: Crossplane is **not a product you compare apples-to-apples with Alethia**. It is a *toolkit you build a platform with* — Alethia is closer to "a finished platform built on top of this kind of capability." Crossplane is more a *substrate Alethia competes against the build-vs-buy of* than a rival PaaS.

## How it works
- **Deploy model**: Crossplane runs **as a controller inside your own Kubernetes cluster** — there is no hosted control plane in the core project. You install it, install **Providers** (AWS/GCP/Azure/etc.), and define **CompositeResourceDefinitions (XRDs)** + **Compositions** (templates) so developers can file **Claims** that provision **Managed Resources**. ([docs](https://docs.crossplane.io/latest/get-started/get-started-with-composition/))
- **What it provisions**: anything a Provider exposes — cloud infra primitives (RDS/EKS/VPC/IAM/queues), Kubernetes objects, and SaaS. It **continuously reconciles** to eliminate drift (its core day-2 strength). ([crossplane.io](https://www.crossplane.io/))
- **What it does NOT do out of the box**: it does **not hand you a finished production cluster + Aurora/ElastiCache/ArgoCD wired to your Git repo**. You (the platform team) must *author* all the Compositions, providers, RBAC, and GitOps wiring yourself. Crossplane is the engine; you build the car.
- **App-delivery / deploy mechanism**: Crossplane has **no app-delivery pipeline**. It provisions/reconciles infra via the K8s API. App delivery is left to whatever you pair it with — typically **ArgoCD/Flux GitOps** apply your XRD claims and your workloads. So it is GitOps-friendly but BYO-GitOps.
- **Upbound (commercial) adds**: "Spaces" = managed control-planes-as-a-service, runnable as **Cloud** (SaaS), **Connected**, or **Disconnected/air-gapped self-hosted** in your own cluster; a web console, RBAC/identity, enterprise package patches (UXP). ([Upbound Spaces](https://docs.upbound.io/deploy/self-hosted-spaces/))

## Pricing (as of 2026)
Crossplane core is **free, Apache 2.0**. Upbound commercial tiers ([upbound.io/pricing](https://www.upbound.io/pricing)):
- **Community** — Free forever: OSS Crossplane, local web UI, CLI, run in your own cluster, community support.
- **Standard** — **from $1,000/month**: enhanced runtime, run in Upbound Spaces, Google/GitHub identity, RBAC, up to 5 control planes, up to 10 team members.
- **Enterprise** — custom: unlimited control planes/members, enterprise security, group management, email/ticket support.
- **Business Critical** — custom: advanced security/hosting, dedicated support, high SLA.
- **Consumption** — per-resource-per-hour on top of plans: first tier included, then ~**$1.0950/resource-month** decreasing to ~$0.73+ at volume; all plans carry consumption minimums. ([upbound.io/pricing](https://www.upbound.io/pricing))

## Ownership & security model
- **Cloud credentials**: In **open-source Crossplane, credentials live in your cluster** (Provider configs / IRSA / Workload Identity) — there is no third party holding them, because there is no third party. With **Upbound Cloud (SaaS)**, control planes run in Upbound's environment; with **self-hosted Disconnected Spaces**, everything stays in your account and **Upbound states it never stores or sees data originating from a self-hosted Space**. ([Upbound docs](https://docs.upbound.io/manuals/spaces/howtos/self-hosted/attach-detach/))
- **Self-host the control plane**: **Yes, fully** — that is Crossplane's native model (it *is* in your cluster), and Upbound also offers self-hosted Spaces (connected or air-gapped). Strong parity with Alethia's "own it" pillar.
- **Pipeline portability**: **Standard and portable** — pure Kubernetes CRDs/API; pairs with vanilla ArgoCD/Flux. Low proprietary lock-in in the OSS core. Lock-in risk is mostly *your own* Composition library and (if used) Upbound-specific Spaces features.
- **Open source**: Apache 2.0, CNCF-graduated. (More permissive than Alethia's AGPL core.)
- **Lock-in**: Low at the framework level; the real cost is the **build/maintenance burden** of authoring and operating your platform.

## Alethia vs Crossplane
| | Alethia | Crossplane |
| --- | --- | --- |
| Own/self-host the control plane | Yes — ~4 containers (Postgres+S3+app+worker) | Yes — runs in your own K8s cluster (native) |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime; control plane never stores creds | Yes in OSS (creds in your cluster); Upbound Cloud SaaS holds them, self-hosted Spaces don't |
| App-delivery model | Real ArgoCD wired to your Git repo, auto-sync (GitOps, batteries-included) | None built-in; BYO ArgoCD/Flux GitOps on top |
| Self-host the platform | Yes — designed to self-host | Yes — OSS is self-hosted by definition; Upbound Spaces self-hostable |
| Multi-cloud | EKS today; GKE/AKS + Talos/k3s roadmap | Broad today via Providers (AWS/GCP/Azure/many SaaS) |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub | Provider ecosystem (1000s of resources) — very broad but you wire it |
| Open source | AGPL core + commercial ee/ | Apache 2.0, CNCF-graduated |
| Pricing model | OSS free + commercial ee/ | OSS free; Upbound from $1,000/mo + per-resource consumption |
| Day-2 ops | V1 thin dashboard; V2 native console (roadmap) | Continuous reconciliation (drift-free) is a core strength; console via Upbound |

## Where Alethia wins
- **Turnkey vs toolkit**: Alethia delivers a *finished* production cluster + Aurora/ElastiCache/DynamoDB/ArgoCD-wired-to-Git in one Spec. Crossplane gives you an engine and a blank page — you must author every Composition, Provider config, and GitOps wiring yourself.
- **Batteries-included GitOps + operator suite**: Alethia pre-installs and wires ArgoCD, external-secrets, external-dns, LB controller, Karpenter. With Crossplane you assemble and maintain all of that.
- **Zero-trust by architecture, no SaaS option that holds keys**: Alethia's runtime role-assumption is the default with no "give us your cluster" SaaS path; Crossplane's lowest-friction managed path (Upbound Cloud) does run control planes off your account.
- **Time-to-value for a single team**: A team that just wants "a production app platform fast" gets it from Alethia; Crossplane pays off only after a platform team invests in building the abstraction layer.
- **No Kubernetes-platform-engineering prerequisite**: Crossplane assumes deep K8s + CRD authoring skill; Alethia targets the outcome, not the substrate.

## Where Crossplane wins
- **Maturity, scale, and ecosystem**: CNCF-graduated, 3,000+ contributors, used by Nike/SAP/NASA/IBM. Alethia is pre-V1. This is not close on adoption or battle-testing.
- **Breadth of providers today**: thousands of managed resources across AWS/GCP/Azure and SaaS — far wider than Alethia's current EKS-first footprint.
- **Best-in-class continuous reconciliation / drift correction** — a genuine day-2 superpower Alethia does not yet match.
- **More permissive license** (Apache 2.0 vs AGPL) — fewer adoption objections for some enterprises.
- **Composability / extensibility**: you can model literally any API; Alethia is opinionated and narrower by design.
- **Commercial backing + funding**: Upbound ($69M raised) provides enterprise support, SLAs, and a managed console option Alethia has only on the roadmap.

## How to position against them
"Crossplane is the *engine* to build an internal platform — powerful, but you and your platform team are the ones who must build and operate the whole thing. Alethia is the *finished platform*: same Kubernetes-native, drift-free, you-own-it philosophy, but it hands a team a complete production cluster wired to their Git repo on day one — no Composition library to author, no platform-engineering org required." Lead with build-vs-buy: Alethia is the opinionated, batteries-included answer for teams who want Crossplane's outcomes without becoming Crossplane experts.

## Sources
- https://www.crossplane.io/
- https://www.cncf.io/announcements/2025/11/06/cloud-native-computing-foundation-announces-graduation-of-crossplane/
- https://www.cncf.io/blog/2021/09/14/crossplane-moves-from-sandbox-to-cncf-incubator/
- https://docs.crossplane.io/latest/get-started/get-started-with-composition/
- https://docs.crossplane.io/v1.20/concepts/claims/
- https://www.upbound.io/pricing
- https://docs.upbound.io/deploy/self-hosted-spaces/
- https://docs.upbound.io/manuals/spaces/howtos/self-hosted/attach-detach/
- https://www.upbound.io/resources/upbound-spaces-self-hosted-control-planes
- https://techcrunch.com/2021/11/29/upbound-grabs-60m-series-b-to-grow-open-source-crossplane-cloud-management-project/
- https://spacelift.io/blog/crossplane-vs-terraform
