# Alethia vs Azin

## Snapshot
Azin (azin.run) is a **BYOC (Bring-Your-Own-Cloud) PaaS** — "Railway/Vercel-level DX in your own cloud account, without the DevOps." Tagline: *"The last infrastructure decision you'll ever make"* and *"Production infrastructure, without the infrastructure team."* You connect a cloud account, `git push`, and Azin builds a container and deploys it onto a managed Kubernetes runtime in *your* account.

- **Category:** BYOC application platform / managed-Kubernetes PaaS (the same lane as Porter / Qovery / Northflank).
- **Company:** Azin Tech (also referenced as "boxd"), Amsterdam, Netherlands. Founders incl. Savian Boroanca (CEO), Hidde Kehrer, Laurentiu Ciobanu, Michiel Voortman. **Pre-seed stage** per Crunchbase — very early/small. (Founding year not publicly confirmed; treat as 2024–2025-era.)
- **Business model:** Flat monthly platform-fee SaaS (free → €100/mo → enterprise) + optional usage-based hosted compute. **BYOC at zero markup** — your cloud bill stays your cloud bill. A managed control plane runs Azin's orchestration; the data plane runs in your cloud.

## How it works
- **Hosted control plane, data plane in your account.** Azin is a **fully managed platform** — *"you do not install, update, or maintain anything."* Their orchestration/control plane is SaaS; your workloads, databases, and networking run in your own cloud.
- **What it provisions (GCP today):** **GKE Autopilot** as the container runtime ("first cluster free, $0 cluster overhead, pay only for pods"), **Cloud SQL** (managed Postgres/MySQL), and **Memorystore** (managed Redis), provisioned automatically. **GCP BYOC is live today; AWS is on the roadmap, Azure planned** — so it is effectively **single-cloud (GCP) in practice right now.**
- **What it deploys:** connects a GitHub repo, builds a container with a zero-config builder (Railpack-style, no YAML), and ships it to GKE Autopilot. Features: a **visual deployment canvas** (drag-and-connect services), **natural-language infra** ("describe it, deploy it"), **GitHub Actions** CI integration, **full-stack PR preview environments**, and built-in metrics/logs/Slack alerts.
- **Deploy mechanism:** a **proprietary build+deploy pipeline** (their builder + GitHub Actions glue + GKE Autopilot). **No ArgoCD / GitOps**; the app-delivery path is Azin's, not standard Kubernetes tooling you'd own and keep.
- **Day-2:** observability (metrics, logs, alerts), autoscaling via GKE Autopilot, preview envs — a more polished console-driven day-2 story than Alethia V1.

## Pricing (as of 2026, from azin.run/pricing)
- **Free — €0/mo:** 3 projects, 5 services, 1 member, 2 custom domains, dev tiers only, €10 hosting credits.
- **Launch — €20/mo:** 10 projects, 15 services, 10 members, unlimited domains, all tiers/builders.
- **Scale — €100/mo:** 50 projects, 50 services, unlimited members, unlimited domains.
- **Enterprise — custom.**
- **No per-seat fees; BYOC on all tiers at zero compute markup** — *"Your cloud bill is your cloud bill. No markup."*
- **Optional hosted compute (usage):** vCPU €0.025/hr, RAM €0.0084/GB/hr, volume €0.00015/GB/hr, object storage €0.015/GB/mo; €10 free credits (+€5 with a card), auto-recharge from €20.
- Plus startup programs / cloud credits for qualifying startups.

## Ownership & security model
- **Cloud credentials:** Azin connects to your GCP project and provisions resources there; the **exact IAM mechanism (granted service account vs. stored key vs. role) is not publicly documented** on the site or docs as of this research — *unverified*. BYOC architecturally keeps your data/secrets/networking in your account, but whether Azin's control plane holds standing credentials to your project is not disclosed. This is a real gap Alethia should probe — Alethia's runtime role-assumption with **zero stored credentials** is an explicit, documented guarantee.
- **Self-host THEIR control plane: No.** Azin is fully managed SaaS — you cannot run the Azin control plane yourself. If Azin goes away, the orchestration goes away.
- **Open source: No** (not advertised as open source anywhere found).
- **Deploy pipeline:** **proprietary.** Apps deploy through Azin's builder/pipeline, not standard ArgoCD/Kustomize/Helm. If you leave Azin, you keep the cloud resources (they're in your account) but lose the deploy/glue layer — partial portability.
- **Lock-in:** medium. You own the *infra* (it's in your cloud) but rent the *platform* (control plane + deploy pipeline are Azin's SaaS, not self-hostable, not open).

## Alethia vs Azin
| Dimension | Alethia | Azin |
| --- | --- | --- |
| Own / self-host the control plane | Yes — self-host as ~4 containers (Postgres + S3 + app + worker) | No — fully managed SaaS only |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime, control plane stores none | Unverified / not disclosed; BYOC data plane in your account |
| App-delivery model | Standard ArgoCD GitOps wired to your repo, auto-sync | Proprietary builder + GitHub Actions → GKE (no GitOps) |
| Self-host the platform | Yes (AGPL core) | No |
| Multi-cloud | AWS today; GKE/AKS + Talos/k3s roadmap | GCP only today; AWS/Azure roadmap |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub | GitHub, Slack, GCP-native (Cloud SQL/Memorystore); narrower |
| Open source | Yes — AGPL core + commercial ee/ | No |
| Pricing model | Open-core; self-host free; commercial EE | €0–€100/mo + custom; usage-based hosted compute |
| Day-2 ops | Thin dashboard in V1; native console in V2 (roadmap) | More mature today — console, observability, preview envs |

## Where Alethia wins
- **You can own and self-host the entire control plane.** Azin's control plane is SaaS-only; if it disappears, so does your deploy/management layer. Alethia runs as ~4 containers you control.
- **Documented zero-trust credential model.** Alethia's worker assumes cloud roles at runtime and the control plane stores no cloud credentials — a stated guarantee. Azin's IAM/credential model is undocumented; an early-stage vendor holding standing access to your GCP project is an unanswered risk.
- **Standard, portable GitOps.** Alethia installs real ArgoCD wired to your git repo (Kustomize/Helm). Azin's pipeline is proprietary — leave and you lose the deploy layer; with Alethia the deploy machinery is standard and yours.
- **Open source (AGPL).** Inspectable, forkable, no vendor-survival risk. Azin is closed and pre-seed.
- **Real multi-cloud trajectory + full operator suite** (external-secrets, external-dns, LB controller, Karpenter, metrics-server) and broader managed-service provisioning (Aurora/ElastiCache/DynamoDB/SQS-SNS/ECR/S3/Secrets-Manager/Route53/WAF), vs Azin's GCP-only Cloud SQL + Memorystore set.

## Where Azin wins
- **DX polish and day-2 maturity today.** Visual deploy canvas, natural-language infra, PR preview environments, built-in logs/metrics/Slack alerts — a slick end-to-end developer experience that beats Alethia V1's "provision & own + thin dashboard."
- **GKE Autopilot zero-overhead runtime.** "First cluster free, pay only for pods, $0 cluster overhead" is a genuinely cheaper/simpler GCP floor than running a full EKS control plane.
- **Lower, simpler price floor.** A €20/mo production tier with no per-seat fees and no compute markup is easy to adopt; Alethia's value is clearer for teams who care about ownership than for a solo dev who just wants `git push`.
- **Truly zero-config builds + preview envs out of the box** — Alethia hands you a cluster + ArgoCD but expects you to bring manifests; Azin abstracts that entirely.
- **Focused, finished single-cloud product.** GCP-only but *complete*, vs Alethia spreading across clouds and an earlier maturity curve.

## How to position against them
"Azin gives you Railway-style DX but rents you the platform — a closed, pre-seed, GCP-only control plane you can't self-host, with a proprietary deploy pipeline and an undisclosed grip on your cloud. Alethia gives you the same `git-push-to-production` outcome on **standard ArgoCD GitOps**, with a control plane **you can self-host** (AGPL) and a **zero-stored-credentials** model — you own the cluster *and* the platform, not just the cloud bill."

## Sources
- https://azin.run/ (homepage, positioning, taglines)
- https://azin.run/pricing (pricing tiers, BYOC/no-markup, hosted compute rates)
- https://azin.run/blog/best-byoc-cloud-platforms (GCP-only today, AWS/Azure roadmap, GKE Autopilot "first cluster free")
- https://azin.run/blog/best-coolify-alternatives ("fully managed", Cloud SQL/Memorystore, GCP live / AWS roadmap)
- https://azin.run/product/claw-now (GKE Autopilot architecture, managed-service positioning)
- https://www.crunchbase.com/organization/azin-technology (company / boxd, Amsterdam, founders, pre-seed) — accessed via search summary (page 403 to direct fetch)
- https://stackshare.io/stackups/azin-deploy-to-your-own-cloud-vs-releasehub (third-party "deploy to your own cloud" framing)
