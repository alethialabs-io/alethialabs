# Alethia vs Railway

## Snapshot
Railway is a hosted full-stack PaaS — the modern Heroku — where you deploy apps, services, and databases from a Git push, Docker image, or CLI, and they run on infrastructure Railway owns. Category: hosted PaaS (not BYOC, not self-hosted). Founded 2020 by Jake Cooper, San Francisco. Raised a **$100M Series B announced Jan 22, 2026** (led by TQ Ventures, with FPV, Redpoint, Unusual), bringing total funding to ~$124M; reports 2M+ developers and 10M+ deploys/month. Business model: subscription floor + per-second usage-based billing for compute it runs on its own vertically-integrated data centers.

## How it works
- **Hosted control plane AND data plane — both Railway's.** Unlike a BYOC vendor, Railway does not run workloads in your AWS/GCP/Azure account. They built custom data centers in 2024 and run everything on hardware they own. Railway states this plainly: *"Railway is not a BYOC platform. We run a managed PaaS on infrastructure we own."*
- **What it provisions:** managed PostgreSQL, MySQL, Redis, and MongoDB (one-click from the UI), plus services, background workers, and cron jobs. A template marketplace one-clicks common stacks. Private networking, replicas (horizontal scale), automatic backups.
- **Deploy mechanism (proprietary pipeline, not GitOps):** connect a GitHub repo and a `git push` triggers Railway's own build+deploy. Builds use **Railpack** (their open-source, BuildKit-based successor to Nixpacks) or your Dockerfile/Docker image. There is no ArgoCD, no Kustomize, no cluster you can `kubectl` into — the orchestration is Railway's internal, opaque pipeline.
- **Kubernetes/infra:** abstracted away entirely. You never see a cluster, IAM role, or VPC — that is the explicit value proposition ("the PaaS experience without taking on Kubernetes, IAM, and VPC as a side project").

## Pricing
As of 2026 (railway.com/pricing, docs.railway.com):
- **Trial:** one-time $5 credit grant, no credit card.
- **Hobby:** $5/month, includes $5 of usage.
- **Pro:** $20/month per seat, includes $20 of usage; higher limits, longer log retention, team features.
- **Enterprise:** custom pricing — contractual SLAs, SSO, dedicated support.
- **Usage (billed per-second, on top of plan fee):** RAM ~$10/GB/month, CPU ~$20/vCPU/month, network egress ~$0.05/GB, volume storage ~$0.15/GB/month. Railway claims this is meaningfully cheaper than hyperscalers due to owning its hardware.

## Ownership & security model
- **Do they hold your cloud credentials?** There are no cloud credentials to hold — Railway *is* the cloud. Your code, data, and databases live entirely on Railway's infrastructure, not in an account you control. There is no role-assumption / zero-trust handoff because there is no customer cloud account in the loop.
- **Can you self-host their control plane?** No. There is no self-hostable Railway. The only open-source pieces are the build tools (Railpack, Nixpacks); the platform, scheduler, API, and orchestration are closed and run only by Railway.
- **Proprietary or portable pipeline?** Proprietary. Builds produce a portable OCI image, but the deploy/orchestration layer is Railway-specific — there is no standard ArgoCD/Helm artifact you could lift to your own cluster.
- **Lock-in:** high at the platform/operations layer. Your build inputs (Dockerfile, source) are portable; your running platform, databases, networking, and operational tooling are not. Leaving means rebuilding your runtime elsewhere.

## Alethia vs Railway

| Capability | Alethia | Railway |
|---|---|---|
| Own/self-host the control plane | Yes — self-host as ~4 containers (Postgres + S3 + app + worker) | No — closed, Railway-run only |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime; control plane never stores creds | N/A — runs entirely on their infra; your code + data live on Railway |
| App-delivery model | Real ArgoCD/Kustomize/Helm wired to your Git repo (GitOps) | Proprietary build+deploy pipeline (Railpack/Dockerfile), Git autodeploys |
| Self-host the platform | Yes (AGPL core) | No |
| Multi-cloud | Yes — AWS today; GCP/AKS + Talos/k3s roadmap | No — Railway's own data centers only |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub, external-secrets/external-dns | Template marketplace + built-in DBs; integrations within Railway's walls |
| Open source | Yes — AGPL core + commercial ee/ | No (only build tools Railpack/Nixpacks are OSS) |
| Pricing model | Self-host = infra cost only; hosted/commercial tiers | $5/$20 floors + per-second usage on their compute |
| Day-2 ops | Thin dashboard visibility today; native console is V2 roadmap | Mature — visual canvas, logs, metrics, rollbacks, replicas |

## Where Alethia wins
- **You own the production cluster.** Alethia hands you a real EKS cluster (kubeconfig + ArgoCD URL + endpoints) in your own account; with Railway you rent capacity on their hardware and never get a portable cluster.
- **You can self-host the entire control plane** as ~4 containers with no SaaS dependency — Railway has no self-host story at all.
- **Zero-trust by design:** Alethia's worker assumes cloud roles at runtime and the control plane never persists credentials. (Railway sidesteps this only by being the cloud itself — your data lives on their metal.)
- **Standard, portable GitOps:** real ArgoCD/Kustomize/Helm wired to your repo, so your delivery pipeline survives leaving Alethia. Railway's deploy layer is proprietary and non-portable.
- **Multi-cloud and provider-agnostic** vs Railway's single, Railway-owned footprint — relevant for data residency, compliance, and avoiding a single-vendor blast radius (third parties flagged recurring Railway outages through mid-2026).
- **AGPL open source** vs a closed platform.

## Where Railway wins
- **Developer experience is best-in-class.** Push-to-deploy in minutes, zero infra knowledge required — Alethia today gives you a cluster you still operate; Railway gives a polished no-ops runtime.
- **Maturity and scale:** 2M+ developers, 10M+ deploys/month, years in production, and a $124M war chest. Alethia is pre-V1.
- **Day-2 operations are real and shipping now** — visual project canvas, per-service logs/metrics, instant rollbacks, replicas. Alethia's equivalent native console is a V2 roadmap item.
- **One-click managed databases** (Postgres, MySQL, Redis, MongoDB) with backups and private networking, no Terraform or operators to wire up.
- **Owned, vertically-integrated hardware** lets Railway undercut hyperscaler pricing and bill cleanly per-second — a unit-economics edge Alethia (running in your cloud) cannot match.
- **No cloud account, IAM, or VPC required** — for teams that explicitly do not want to own Kubernetes, that simplicity is a genuine feature, not a bug.

## How to position against them
Railway is the purest anti-Alethia: its entire pitch is "we own the infrastructure so you never touch Kubernetes, IAM, or a cloud account" — which means your code, data, and runtime all live on Railway's metal with no cluster you can take with you. Alethia offers the same fast path to a production app platform, but you own the cluster *and* can self-host the control plane — sell it as "Railway's speed, but it's yours: a real, standard, portable platform in your cloud instead of rented capacity in theirs."

## Sources
- https://railway.com/pricing
- https://docs.railway.com/reference/pricing/plans
- https://blog.railway.com/p/what-is-byoc-developer-guide-2026
- https://blog.railway.com/p/series-b
- https://venturebeat.com/infrastructure/railway-secures-usd100-million-to-challenge-aws-with-ai-native-cloud
- https://github.com/railwayapp/railpack
- https://blog.railway.com/p/introducing-railpack
- https://docs.railway.com/databases
- https://docs.railway.com/deployments/github-autodeploys
- https://northflank.com/blog/railway-vs-render
- https://northflank.com/blog/best-paas-that-runs-in-my-own-cloud-account-bypc-self-hosted-paas
