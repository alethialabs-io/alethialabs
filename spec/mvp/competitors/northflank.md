# Alethia vs Northflank

## Snapshot
Northflank is a Kubernetes-based developer platform (PaaS) for deploying apps, databases, and AI/GPU workloads, with a strong Bring-Your-Own-Cloud (BYOC) story. Category: BYOC + hosted PaaS. Founded 2019 in London, UK by Will Stewart and Frederik Brix. Raised ~$22.3M in 2025 (Bain Capital Ventures-led $16M Series A + a $6.3M seed led by Alethia Ventures US; ~$25M total). ~$2.1M revenue, ~19-person team (Sept 2025). Business model: consumption-based PaaS compute on Northflank's platform, plus BYOC/Enterprise where you pay your own cloud + a platform fee. Of all the "anti-Porter" competitors, Northflank is the most directly threatening on ownership.

## How it works
Three deployment shapes:
1. **Managed PaaS** — workloads run on Northflank's own infrastructure; pure hosted SaaS.
2. **BYOC (self-serve)** — Northflank provisions and manages a Kubernetes cluster (EKS/GKE/AKS/OKE, plus CoreWeave, Civo, bare-metal/on-prem) inside *your* cloud account. Workloads, data, databases, logs, and secrets stay in your VPC; only "orchestration metadata" flows to Northflank's control plane. They also offer **BYOK** (Bring Your Own Kubernetes) to import an existing EKS/GKE/AKS/OpenShift/RKE2/on-prem cluster.
3. **Enterprise forward-deployed control plane** — Northflank's control plane itself can be deployed in your VPC/data center with air-gap support for classified/disconnected networks.

What it provisions: the K8s cluster + nodes (in BYOC), managed addon databases, GPU scheduling. What it deploys: your app via **their proprietary build/release pipeline** — build from Git (Dockerfile or buildpacks), CI on commit/branch/PR, CD rolls out the latest build. They expose "Choice of UI, CLI, APIs & GitOps" and integrate GitHub/GitLab/Bitbucket, but the default app-delivery path is Northflank's own pipeline, not standard ArgoCD wired to your repo.

## Pricing (as of 2026)
- **Sandbox (free)**: always-on compute, 2 free services, 1 free database, 2 free cron jobs. ([pricing](https://northflank.com/pricing))
- **Pay-as-you-go**: no monthly minimum, no per-seat fee, billed per-second. Compute $0.01667/vCPU-hr, $0.00833/GB-hr; SSD $0.15/GB-mo; egress $0.06/GB. Predefined plans from $2.70/mo (0.1 vCPU/256MB) up. GPUs hourly: L4 $0.80, A100-40 $1.42, H100-80 $2.74. ([pricing](https://northflank.com/pricing))
- **Enterprise**: custom/invoice, volume + annual discounts, SLAs, white-label, BYOC/on-prem/air-gap. ([enterprise](https://northflank.com/enterprise))
- **BYOC economics**: you pay your cloud provider directly + a Northflank platform fee, with "no markup on underlying compute." Northflank markets itself as "the only platform offering self-serve BYOC with publicly available pricing" (their example: 200 sandboxes = $2,060 BYOC vs $7,200 on their PaaS). ([BYOC blog](https://northflank.com/blog/best-byoc-sandbox-platforms))

## Ownership & security model
- **Cloud credentials**: in BYOC, Northflank connects to your cloud account to provision and manage the cluster; they state "Northflank never has access to your workload data or secrets" and data stays in your VPC. They are an ongoing managed control plane, so they retain operational access to manage the cluster (less "zero-trust runtime role assumption, never stored" than Alethia's model — verify the exact credential/role mechanics during a deeper technical eval; not fully documented publicly).
- **Self-host their control plane**: Yes, but only at the **Enterprise tier** as a forward-deployed/air-gapped deployment — not the default, not self-serve, not open-source. Self-serve BYOC still uses Northflank's hosted control plane.
- **Deploy pipeline**: proprietary build+release pipeline (their CI/CD). Portable insofar as you bring your own Dockerfile and can use registries, but the orchestration/release layer is Northflank's, not standard ArgoCD/Kustomize you keep.
- **Open source**: No. Closed-source commercial platform.
- **Lock-in**: medium. The cluster and data live in your account (low data lock-in), but the control plane, pipelines, and operational model are Northflank's. Leaving means rebuilding your delivery layer.

## Alethia vs Northflank

| Dimension | Alethia | Northflank |
|---|---|---|
| Own/self-host the control plane | Yes — ~4 containers, self-serve, AGPL | Only via Enterprise forward-deployed/air-gap; not self-serve, closed-source |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime, control plane never stores creds | BYOC keeps data in your VPC, but Northflank retains managed operational access; not a "never-stored" model |
| App-delivery model | Standard ArgoCD wired to your Git repo (GitOps, you own it) | Proprietary build/release pipeline (Git build → CD); GitOps offered but not the default |
| Self-host the platform | Yes — core is AGPL, self-hostable by anyone | Only paid Enterprise; closed-source |
| Multi-cloud | EKS today; GKE/AKS + Talos/k3s roadmap | AWS/GCP/Azure/Oracle/CoreWeave/Civo/bare-metal/on-prem — broader, shipping today |
| Pluggable integrations | Cloudflare DNS, Vault, Datadog/Grafana/Prometheus, Docker Hub, external-secrets/external-dns/Karpenter | Mature managed addons, registries, GitHub/GitLab/Bitbucket, GPU; broad but inside their platform |
| Open source | Yes (AGPL core + commercial ee/) | No |
| Pricing model | Open-source/self-host; commercial ee for orgs | Consumption (per-vCPU/GB/sec) + Enterprise; BYOC = your cloud + platform fee |
| Day-2 ops | Thin dashboard now; native console is V2 roadmap | Mature: logs, metrics, rollbacks, pipelines, preview envs, RBAC, GPU — strong today |

## Where Alethia wins
- **True self-hostable, open-source control plane (AGPL).** Anyone can run all of Alethia as ~4 containers with no SaaS dependency; Northflank's self-hosted control plane is closed-source and gated behind Enterprise sales.
- **Cleaner zero-trust credential story.** Alethia's worker assumes cloud roles at runtime and the control plane never stores credentials; Northflank remains a persistent managed control plane with ongoing operational access to your cluster.
- **Standard, portable GitOps you own.** Alethia installs real ArgoCD wired to your repo with auto-sync — the delivery layer is industry-standard and survives Alethia's removal. Northflank's default delivery is its own pipeline.
- **You walk away with a vanilla, standards-based cluster + operator suite** (external-secrets, external-dns, LB controller, Karpenter) that is not entangled with a vendor's orchestration layer.
- **No vendor in the deploy loop.** A git push deploys via your ArgoCD, not through a third-party control plane.

## Where Northflank wins
- **Far more mature and funded.** ~$25M raised, real revenue, years in production, polished UX. Alethia is V1.
- **Best-in-class BYOC breadth, today.** AWS/GCP/Azure/Oracle/CoreWeave/Civo/bare-metal/on-prem + BYOK import of existing clusters — Alethia is EKS-only today with the rest on the roadmap.
- **Strong day-2 operations now.** Logs, metrics, rollbacks, pipelines, preview environments, RBAC, managed databases, and first-class GPU/AI workloads — the exact V2 surface Alethia hasn't built yet.
- **Self-serve BYOC with public pricing and air-gap option** — a genuinely hard combination to match; Northflank executes it commercially today.
- **Managed databases and GPU scheduling out of the box**, including a clear AI/agent-workload focus.
- **Transparent, granular consumption pricing** with a real free tier and no per-seat cost.

## How to position against them
"Northflank is the closest thing to us — but they're still a closed-source vendor whose control plane and delivery pipeline you rent; self-hosting it requires an Enterprise contract. Alethia hands you a standard, ArgoCD-wired cluster you fully own and lets *anyone* self-host the entire open-source control plane with zero stored credentials — same BYOC outcome, no vendor in the loop." (Concede day-2 maturity and multi-cloud breadth today; win on open-source ownership, zero-trust creds, and standard GitOps.)

## Sources
- https://northflank.com/pricing
- https://northflank.com/features/bring-your-own-cloud
- https://northflank.com/enterprise
- https://northflank.com/blog/best-byoc-sandbox-platforms
- https://northflank.com/blog/best-paas-that-runs-in-my-own-cloud-account-bypc-self-hosted-paas
- https://northflank.com/docs/v1/application/release/continuous-integration-and-delivery-on-northflank
- https://northflank.com/docs/v1/application/build/build-code-from-a-git-repository
- https://venturebeat.com/ai/exclusive-northflank-scores-22-3-million-to-make-cloud-infrastructure-less-of-a-nightmare-for-developers
- https://www.crunchbase.com/organization/northflank
- https://getlatka.com/companies/northflank.com
- https://www.qovery.com/blog/northflank-alternatives
