# Alethia vs Qovery

## Snapshot
Qovery is a BYOC Kubernetes control plane / app-PaaS: connect a Git repo + your cloud account, and Qovery provisions managed Kubernetes (EKS/GKE/AKS/Scaleway) in *your* account and deploys apps into it. In 2026 it has repositioned around "Kubernetes control plane for humans **and AI agents**" — guardrails, RBAC, policy-as-code, and audit logging so coding agents (Claude Code, Cursor) can ship to prod safely.
- **Category:** BYOC app-PaaS / Kubernetes control plane (the closest structural analog to Alethia).
- **Founded / HQ:** 2020, Paris, France (Romaric Philogene, Morgan Perry). ~40+ remote staff.
- **Funding:** $13M Series A (Sep 2025, led by IRIS, at a reported ~$45M valuation); ~$18M total. Backers incl. Speedinvest, Crane, Techstars, Datadog founders, Docker co-founder.
- **Business model:** SaaS subscription (per-org + seats + deploy-minutes); the control plane is hosted by Qovery, your workloads/infra run in your cloud. Self-host/on-prem only on Enterprise.

## How it works
- **Control plane: Qovery-hosted SaaS by default.** "Nothing is hosted by Qovery except the control plane" — your clusters, apps, and data run in your VPC, but the orchestration brain is Qovery's multi-tenant SaaS unless you buy Enterprise (which offers on-prem/self-hosted).
- **Provisions:** end-to-end Kubernetes — EKS / GKE / AKS / Scaleway Kapsule (plus bring-your-own clusters: EKS Anywhere, OpenShift, k3s, bare metal). Sets up VPC, subnets, NAT, IAM/IRSA (or GCP Workload Identity / Azure pod identity), ingress, cert-manager, external-dns, and monitoring agents as managed add-ons.
- **Deploys:** apps from Git via Buildpacks or Dockerfile (or any OCI image), as an "environment graph" (apps + DBs + Terraform + Helm as one unit). PR-triggered ephemeral preview environments. Terraform modules and Helm charts are first-class deployable services.
- **Deploy mechanism = Qovery's own engine (GPL-3.0, Rust), NOT standard ArgoCD GitOps.** It wraps Terraform + Helm + kubectl + Docker. It can *bridge* an existing ArgoCD or your GitHub Actions/GitLab CI, but the canonical path is Qovery's proprietary deployment pipeline, not a vanilla ArgoCD-wired-to-your-repo handoff.
- **Databases:** managed via Qovery's container/cloud-managed DB abstraction; it is application-platform-centric and does not advertise the broad managed-data + messaging suite (Aurora/ElastiCache/DynamoDB/SQS-SNS/Secrets-Manager/Route53/WAF) that an Alethia Spec provisions in one shot.

## Pricing (as of 2026, from qovery.com/pricing)
- **No free tier.** Free trial only.
- **Team — from $899/mo:** 10 users + 10 AI agent seats, 2 managed clusters, up to 100 environments, 5,000 deploy minutes, business-hours support.
- **Business — from $1,999/mo:** 30 users + 30 AI seats, SSO, 3 managed clusters, up to 250 environments, 10,000 deploy minutes, 99.9% SLA, policy-as-code.
- **Enterprise — custom annual:** unlimited users/seats, custom limits, 24/7 + CSM, **on-prem / self-hosted control plane option**.
- **Add-ons:** extra AI agent seats $10/mo each; deploy-minute overages metered. (Historic per-user/per-deploy-minute pricing — e.g. ~$29/user/mo, $0.016/deploy-minute — has been rolled into the flat per-org tiers above.)
- You separately pay your own cloud bill (Qovery never resells compute).

## Ownership & security model
- **Cloud credentials:** Qovery's hosted control plane needs access to provision into your account. It supports **AWS STS / IAM-role assumption** with temporary credentials as the recommended path (vs long-lived keys), and app secrets/env vars are AES-256 encrypted and stored in your cluster's K8s secret store. So with STS it minimizes stored long-term keys — but the SaaS control plane is still the privileged party that orchestrates into your account; this is "managed-access," not architecturally credential-free.
- **Self-host THEIR control plane:** Only on **Enterprise** (on-prem/self-hosted option). Standard Team/Business customers are dependent on Qovery's SaaS control plane.
- **Open source:** the **Qovery Engine** (deployment orchestration layer) is open source under **GPL-3.0** — but it's a *component*, not the full platform. The control plane, UI, RBAC/policy/audit, and AI-agent layer are proprietary SaaS.
- **Deploy pipeline:** proprietary Qovery engine. Portable-ish (Terraform/Helm under the hood, can bridge ArgoCD) but the orchestration and environment-graph model are Qovery's, so leaving means rebuilding your delivery layer.
- **Lock-in:** moderate. You own the cluster and infra; you do *not* own the control plane or the deploy abstraction unless you pay for Enterprise self-host.

## Alethia vs Qovery

| Capability | Alethia | Qovery |
| --- | --- | --- |
| Own / self-host the control plane | Yes — self-host the whole control plane (~4 containers) on any tier | Only on Enterprise; SaaS-hosted by default |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime; control plane never holds creds | Partial — STS/role-assumption supported, but hosted control plane holds privileged access |
| App-delivery model | Standard ArgoCD wired to your Git repo (real GitOps) | Qovery's own engine (proprietary pipeline); can bridge ArgoCD |
| Self-host the platform | Yes (AGPL core) | Engine is GPL-3.0; full platform self-host = Enterprise only |
| Multi-cloud | EKS today; GKE/AKS + Talos/k3s roadmap | EKS/GKE/AKS/Scaleway + BYO-cluster (broader, shipping today) |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub | Mature integration catalog (secrets mgrs, observability, CI) |
| Open source | AGPL core + commercial ee/ | Engine GPL-3.0; rest proprietary |
| Pricing model | OSS / self-host; commercial ee tier | From $899/mo (Team) → $1,999/mo (Business) → custom |
| Day-2 ops | Thin dashboard now; native console in V2 | Mature: previews, RBAC, policy-as-code, audit, AI-agent guardrails |

## Where Alethia wins
- **Truly credential-free architecture.** Alethia's worker assumes roles at runtime and the control plane *never* stores or holds privileged access; Qovery's hosted control plane is always a privileged orchestrator into your account, even with STS.
- **Self-host the control plane on day one, for free.** Alethia is AGPL and runs as ~4 containers you own; Qovery gates self-hosted/on-prem behind the Enterprise tier.
- **Standard, portable app-delivery.** Alethia hands you real ArgoCD wired to your repo — if you delete Alethia tomorrow, the cluster + GitOps keep running. Qovery's engine is the delivery layer; removing Qovery means rebuilding your pipeline.
- **Broader provisioned stack in one Spec.** Alethia provisions Aurora/ElastiCache/DynamoDB/SQS-SNS/ECR/S3/Secrets-Manager/Route53/WAF alongside the cluster; Qovery is app-platform-centric and leaves most managed data/messaging services to you.
- **No per-seat / per-deploy-minute meter** — Alethia's OSS/self-host model has no $899 floor and no metered deploy minutes.

## Where Qovery wins
- **Far more mature and funded.** $13M Series A (2025), 6 years in market, 200+ orgs / 1000+ clusters managed — Alethia is pre-V1.
- **Superior day-2 DX.** Preview environments, environment cloning, environment-graph deploys, RBAC, policy-as-code, audit logs, billing analytics — this is exactly Alethia's *V2* roadmap, shipping in Qovery today.
- **Broader multi-cloud, today.** EKS + GKE + AKS + Scaleway + BYO-cluster (OpenShift/k3s/bare metal) are GA; Alethia is EKS-only with the rest on roadmap.
- **The AI-agent guardrails story is real and timely.** Scoped, audited, policy-checked agent actions into prod is a genuine differentiator Alethia has no answer to yet.
- **Bigger ecosystem & integrations.** Terraform provider, CLI, MCP server, mature secrets/observability/CI integrations and docs.
- **Battle-tested at scale** with SOC 2 / HIPAA-readiness messaging that enterprise buyers expect.

## How to position against them
"Qovery runs *its* SaaS control plane and *its* deploy engine as the privileged middleman into your cloud — and you only get to own/self-host that brain if you buy Enterprise. Alethia gives you a real cluster wired to *standard* ArgoCD/Git, a control plane you can self-host on day one for free, and a worker that assumes roles at runtime so the platform never holds your keys — same fast outcome, opposite ownership model. They beat us today on day-2 polish and multi-cloud breadth; we beat them on ownership, credential-trust, and portability."

## Sources
- https://www.qovery.com/ (2026 positioning: "Agents ship fast. Guardrails keep them safe.")
- https://www.qovery.com/pricing (Team $899/mo, Business $1,999/mo, Enterprise custom, AI seats $10/mo)
- https://www.qovery.com/product/provision (EKS/GKE/AKS/Scaleway + VPC/IAM/ingress/cert-manager/external-dns)
- https://www.qovery.com/product/deploy (deploy engine, environment graph, Buildpacks/Dockerfile, ArgoCD bridging)
- https://github.com/Qovery/engine (Qovery Engine, GPL-3.0, Rust, Terraform/Helm/kubectl/Docker)
- https://www.qovery.com/blog/we-have-open-sourced-our-deployment-engine
- https://www.qovery.com/blog/qovery-now-supports-aws-sts-protect-your-resources-with-temporary-access-keys
- https://www.qovery.com/about (founded 2020, Paris, founders, backers)
- https://www.qovery.com/blog/13m-serie-a-funding ($13M Series A)
- https://tech.eu/2025/09/30/qovery-raises-13m-to-redefine-devops-automation/ ($13M Series A, led by IRIS)
- https://northflank.com/blog/best-paas-that-runs-in-my-own-cloud-account-bypc-self-hosted-paas (third-party BYOC comparison)
- https://www.qovery.com/blog/porter-alternatives (Qovery's own competitive framing)
