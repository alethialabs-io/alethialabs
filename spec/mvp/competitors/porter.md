# Alethia vs Porter

## Snapshot
Porter (porter.run) is a Kubernetes-powered "Bring Your Own Cloud" PaaS — "Heroku in your own cloud." You point it at a GitHub repo and it builds, deploys, and autoscales your app on a managed cluster (EKS/GKE/AKS) running inside your own AWS/GCP/Azure account.
- **Category:** BYOC app-PaaS (managed K8s + proprietary deploy pipeline).
- **Founded / funding / HQ:** Y Combinator S20; $20M Series A led by FirstMark Capital (with YC + angels Dalton Caldwell, Ali Rowghani); San Francisco (Dogpatch). A top-five all-time YC dev tool by adoption.
- **Business model:** Usage-based SaaS — Porter hosts the control plane and charges per vCPU/GB-RAM of workloads it manages, on top of your underlying cloud bill. Enterprise tier for RBAC/SSO/support.

## How it works
- **Control plane = Porter's SaaS.** Your *workloads* run in your cloud account, but the PaaS layer — Porter's "Cluster Control Plane" — is hosted by Porter and monitored 24/7 by Porter SREs. You manage everything through Porter's hosted dashboard/CLI, not infrastructure you run.
- **What it provisions:** managed Kubernetes (EKS/GKE/AKS), node groups, VPC/networking, load balancing/ingress, in-cluster Postgres/Redis addons + EFS persistent storage, and Helm-chart addons — all via direct cloud-provider APIs (Porter does **not** use Terraform).
- **What it deploys & how:** point at a GitHub repo → Porter builds via buildpacks or Dockerfile (CI through GitHub Actions) → deploys. Config-as-code via `porter.yaml` (services, builds, settings). Pre-built registry images (ECR/GAR/ACR/Docker Hub) are also supported. This is a **proprietary build-and-deploy pipeline**, not GitOps — there is no ArgoCD/Flux wired to your repo with declarative sync.
- **Porter Cloud:** a separate fully-hosted (non-BYOC) tier where apps run in Porter's account, with an "eject to your own cloud" path later.

## Pricing
*(porter.run/pricing, as of 2026)*
- **Standard — usage-based, no free tier:** ~**$6/mo per GB RAM** ($0.009/hr) + **$13/mo per vCPU** ($0.019/hr), charged on top of your cloud provider bill. No minimum commitment stated. Includes GitHub deploys, unlimited apps, preview environments, autoscaling, jobs/cron, cert management, monitoring, logging, alerting.
- **Enterprise — volume discount (contact sales):** requires ~40 vCPU / 80 GB RAM minimum to qualify. Adds premium support, advanced RBAC, SAML SSO, custom alerts, and on-prem installation.
- **Discounts:** free-for-a-year for YC / a16z / AWS Activate startups; 50% for non-profits.
- Third-party reviews report teams "paying thousands per month" and feeling value didn't match cost.

## Ownership & security model
- **Cloud credentials — strong, comparable to Alethia:** Porter does **not** store static cloud keys. AWS uses an IAM role you create with AssumeRole trust to Porter; GCP uses Workload Identity Federation. (Azure is the exception — a service principal credential rotated annually.) Access is revocable by deleting the role.
- **Permissions footprint:** the role Porter assumes is **broad/admin-level** (EKS, VPC, ECR, IAM, quota changes). Restricted-scope permissions are an Enterprise-only conversation. Reviews note Porter historically "required full admin access for every engineer."
- **Self-host the control plane:** **No.** The control plane is Porter's hosted SaaS. A self-hostable PaaS layer (Helm chart) was promised at the 2021 MIT-licensed launch but was never shipped as a real product.
- **Deploy pipeline portability:** the build/deploy pipeline is **proprietary** to Porter. The cluster keeps running if you leave ("it's your own infrastructure"), but your `porter.yaml` deploy mechanism, preview envs, and day-2 console do not — you'd re-platform onto standard tooling.
- **Open source:** Porter launched MIT-licensed (`porter-dev/porter`), but the platform monorepo is no longer in the org; the **shipping product is closed-source SaaS**. Only CLI, GitHub Actions, Helm charts, and buildpacks remain public.
- **Lock-in:** medium-high — you own the cluster, but the control plane, deploy pipeline, and operational tooling are Porter's hosted black box.

## Alethia vs Porter
| Dimension | Alethia | Porter |
|---|---|---|
| Own / self-host the control plane | Yes — self-host as ~4 containers (Postgres + S3 + app + worker) | No — control plane is Porter's hosted SaaS |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime, none stored | Yes for AWS/GCP (IAM AssumeRole / WIF); Azure SP is the exception |
| App-delivery model | Real ArgoCD/Kustomize/Helm wired to your git repo (GitOps, portable) | Proprietary build+deploy pipeline (`porter.yaml`, GitHub Actions) |
| Self-host the platform | Yes — fully self-hostable, no SaaS dependency | No (self-host promised in 2021, never delivered) |
| Multi-cloud | EKS today; GKE/AKS + Talos/k3s on roadmap | AWS, GCP, Azure all GA today |
| Pluggable integrations | Cloudflare DNS, Vault, Datadog/Grafana/Prometheus, Docker Hub, external-secrets/-dns, LB controller, Karpenter | Built-in monitoring/logging/addons; less emphasis on swapping in your own stack |
| Open source | AGPL core + commercial ee/ | Closed-source product (launched MIT, monorepo since pulled) |
| Pricing model | Open-source / self-host; commercial EE for orgs/SSO | Usage-based per vCPU/GB-RAM on top of cloud bill; no free tier |
| Day-2 ops | Thin dashboard visibility in V1; native console is V2 | Mature: logs, metrics, autoscaling, preview envs, rollbacks, alerting, SRE-monitored |

## Where Alethia wins
- **You can own the entire control plane.** Self-host Alethia as ~4 containers with no SaaS dependency — Porter's control plane is irreducibly their hosted service.
- **Standard, portable GitOps.** Real ArgoCD wired to your git repo with auto-sync; if Alethia disappears, apps still deploy from a `git push`. Porter's `porter.yaml` pipeline is proprietary and non-portable.
- **Genuinely open source (AGPL).** Porter ships closed-source today; its open-source platform was effectively discontinued.
- **Richer wired-in managed AWS stack** out of one Spec — Aurora/ElastiCache/DynamoDB/SQS-SNS/ECR/S3/Secrets Manager/Route53/WAF plus a real operator suite (external-secrets, external-dns, Karpenter), handed to you as a cluster you fully control.
- **Tighter least-privilege story potential** — Porter's default role is broad/admin; restricted scopes are Enterprise-gated.

## Where Porter wins
- **Maturity and scale.** Battle-tested from YC seed startups to post-IPO and $1bn+ revenue companies; $20M Series A and a large customer base. Alethia is early.
- **Day-2 operations, today.** Logs, metrics, autoscaling, preview environments, rollbacks, alerting, and 24/7 SRE-monitored clusters — Alethia V1 has only thin visibility; this is Alethia's V2.
- **Three clouds GA now** (AWS/GCP/Azure) vs Alethia's EKS-only today.
- **DX polish and compliance.** One-click SOC 2 / HIPAA-ready infrastructure, mature dashboard/CLI, buildpacks, preview envs out of the box.
- **Porter Cloud option** — start with zero cloud account and eject to BYOC later; Alethia requires your own cloud from day one.
- **Proven build pipeline** that handles buildpacks/Dockerfiles/registry images with autoscaling — Alethia defers app-build entirely to your GitOps repo.

## How to position against them
"Porter rents you a PaaS whose control plane, deploy pipeline, and day-2 tooling are their closed-source SaaS — you own the cluster, but not the platform on top of it. Alethia hands you the same production outcome built from standard, portable parts — your own ArgoCD/GitOps, an open-source (AGPL) control plane you can self-host as four containers, and zero credentials ever leaving your account." Lead with ownership and portability; concede Porter's maturity and day-2 polish, and target teams who refuse to put their deploy pipeline and control plane inside a vendor black box.

## Sources
- https://www.porter.run/ — product overview, BYOC positioning
- https://docs.porter.run/introduction — "PaaS that runs in your own AWS, GCP, or Azure account"
- https://docs.porter.run/cloud-accounts/connecting-a-cloud-account — IAM AssumeRole / Workload Identity Federation; broad permissions; Enterprise for restricted scopes
- https://www.porter.run/pricing — Standard ($6/GB-RAM, $13/vCPU) and Enterprise tiers, as of 2026
- https://firstmark.com/story/announcing-our-20m-series-a-in-porter-effortless-app-infrastructure-in-the-age-of-ai/ — $20M Series A
- https://www.porter.run/startups/yc — YC S20, free-for-a-year, customer profile
- https://news.ycombinator.com/item?id=26993421 — 2021 Launch HN: MIT license, "only the PaaS layer is hosted by us," self-host-as-Helm-chart future plan
- https://github.com/orgs/porter-dev/repositories — current public repos (CLI/actions/charts only; no platform monorepo)
- https://northflank.com/blog/best-porter-alternatives-for-scalable-deployments — third-party critique (v1→v2 stability, cost, abstraction limits, full-admin-access requirement)
- https://northflank.com/blog/best-paas-that-runs-in-my-own-cloud-account-bypc-self-hosted-paas — Porter Cloud (fully-hosted, non-BYOC) tier
