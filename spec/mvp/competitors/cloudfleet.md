# Alethia vs Cloudfleet

## Snapshot
Cloudfleet (Cloudfleet Kubernetes Engine, "CFKE") is a **fully managed, multi-cloud Kubernetes service**: one Cloudfleet-hosted control plane that spans AWS, GCP, Hetzner, and any on-prem/edge Linux box, with Karpenter-style just-in-time node provisioning and a Tailscale-based encrypted overlay network ("Global Secure Networking"). Cloudfleet GmbH, **designed and engineered in Berlin** ("© 2025 Cloudfleet GmbH"); co-founder **Yegor Tokmakov**. Founding year and funding are not publicly verifiable from accessible sources (Crunchbase page is gated; no disclosed rounds found as of 2026). Business model: SaaS — they sell you a hosted Kubernetes control plane priced per-cluster + per-vCPU, while your worker nodes (and their cloud compute bill) live in your own cloud account.

## How it works
- **Control plane = Cloudfleet's SaaS.** CFKE provisions, scales, patches, and HA-replicates the Kubernetes API server and backend store **in Cloudfleet's infrastructure**, not in your account. The FAQ is explicit: it "eliminates the need for you to install or operate your own Kubernetes control plane." You cannot self-host this control plane.
- **Worker nodes = your account (BYOC).** You connect a "Fleet" to your cloud. For **AWS** Cloudfleet uses **IAM roles + Workload Identity Federation** (credential-less; you run their Terraform module to create the role); for **GCP**, **Workload Identity Federation** (keyless); for **Hetzner**, you paste a Read/Write API token. runners are auto-provisioned just-in-time (Karpenter-style) on AWS/GCP/Hetzner, or you join any Linux server as a "self-managed node" via Terraform/manual.
- **What they provision:** Kubernetes itself (control plane + nodes + overlay networking + OIDC for keyless workload→cloud-API access). They do **not** provision a managed-services stack (databases, caches, queues, DNS, WAF) for you — that's outside CFKE.
- **Deploy mechanism = plain `kubectl`.** The getting-started flow is `cloudfleet clusters kubeconfig … ` then `kubectl create deployment …`. There is **no bundled ArgoCD/GitOps wiring, no Git-repo auto-sync, and no proprietary deploy pipeline** — it's a standard conformant cluster you point your own CD at. (This is portable, but it's also "here's a cluster, BYO delivery.")

## Pricing
Source: <https://cloudfleet.ai/pricing/> (EUR, as of 2026):
- **Basic — Free.** €0/cluster + €0/vCPU, up to **24 vCPUs**, single-AZ shared control plane, **hibernates after 7 days idle**, no credit card.
- **Pro — €69/cluster/mo** + **€4.95/vCPU/mo (first 24 vCPUs free)**, unlimited size, multi-AZ dedicated control plane, always-on, 99.95% uptime SLA, SSO, 8h support SLA.
- **Enterprise — contact sales**, **minimum €5,000/mo or 10% of monthly charges**, 1h support SLA, compliance reports, dedicated TAM.
- **Container Registry (CFCR):** 5 GB free, then €0.085/GB/mo; free unlimited data transfer.
- For Managed Fleets, the **underlying cloud compute is billed by your cloud provider** (it's your account) **on top of** the per-vCPU management fee. Prorated by the minute, no commitments. Pilot program: up to $10k credits for founders.

## Ownership & security model
- **Stored cloud credentials?** Largely **no long-lived creds** — AWS/GCP fleets use role assumption / Workload Identity Federation (keyless), Hetzner uses a pasted API token. On the credential axis, Cloudfleet's posture is similar to Alethia's. **However**, the control plane that holds your API server, etcd state, and cluster keys runs **inside Cloudfleet's SaaS** — that's the real trust boundary.
- **Self-host their control plane?** **No.** CFKE is a hosted service; if Cloudfleet is down or you stop paying, you don't have a control plane. (Worker nodes/data are yours, but the brain isn't.)
- **Open source?** Cloudfleet markets itself as "based on an open-source software stack" (Kubernetes, Karpenter, Tailscale) but **CFKE itself is not open source** and is not distributed for self-hosting. No public AGPL/Apache repo for the platform.
- **Deploy pipeline:** standard/portable (conformant Kubernetes + your own tooling) — a genuine plus.
- **Lock-in:** moderate. The cluster is conformant so workloads are portable, but the **managed control plane, overlay networking, fleet auto-provisioning, and console are proprietary and Cloudfleet-hosted** — leaving means rebuilding your control plane elsewhere.

## Alethia vs Cloudfleet
| Capability | Alethia | Cloudfleet |
|---|---|---|
| Own/self-host the control plane | Yes — you can self-host the whole Alethia control plane (~4 containers) | No — CFKE control plane is Cloudfleet-hosted SaaS only |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime | Mostly yes — AWS/GCP keyless federation; Hetzner uses a stored API token |
| App-delivery model | Real ArgoCD wired to your Git repo, auto-sync from a push (GitOps) | Plain `kubectl`; bring your own CD; no bundled GitOps |
| Self-host the platform | Yes (AGPL core) | No |
| Multi-cloud | EKS today; GKE/AKS + Talos/k3s on roadmap | AWS + GCP + Hetzner + any on-prem/edge Linux node — live today |
| Pluggable integrations | Cloudflare DNS, Vault, Datadog/Grafana/Prometheus, ext-secrets/ext-dns/LB/Karpenter | Built-in OIDC; Tailscale networking; CFCR registry; otherwise BYO via standard K8s |
| Open source | AGPL core + commercial ee/ | No (uses OSS components, but platform is closed) |
| Pricing model | Open-source / self-host; commercial tiers | €0 Basic → €69 + €4.95/vCPU Pro → €5k/mo Enterprise |
| Day-2 ops | Thin dashboard now; native console on V2 roadmap | Strong — managed upgrades, HA control plane, autoscaling, single pane across clouds/edge |

## Where Alethia wins
- **You own the control plane.** Alethia is self-hostable end-to-end (~4 containers); Cloudfleet's control plane is permanently in their cloud — a hard ceiling for air-gapped, sovereignty, or "no-SaaS-dependency" buyers.
- **GitOps in the box.** Alethia installs ArgoCD and wires it to your repo so a git push deploys; Cloudfleet hands you a bare cluster and `kubectl` — you build the delivery story yourself.
- **Full production stack, not just K8s.** Alethia also provisions Aurora/ElastiCache/DynamoDB/SQS-SNS/ECR/S3/Secrets-Manager/Route53/WAF + the operator suite; CFKE scope stops at the cluster.
- **Open source / no vendor dependency.** AGPL core means no "Cloudfleet is down → your control plane is down" failure mode and no per-vCPU rent on the brain.
- **Pluggable integrations** (Cloudflare, Vault, Datadog, etc.) are first-class in Alethia's provisioning spec; Cloudfleet leaves most of that to you.

## Where Cloudfleet wins
- **Shipping, mature, multi-cloud today.** AWS + GCP + Hetzner + on-prem/edge in **one** control plane is live now; Alethia is EKS-only today with GKE/AKS still roadmap.
- **Genuinely better day-2 ops right now.** Managed HA control plane, automatic upgrades/patching, release channels, 99.95% SLA, just-in-time Karpenter autoscaling, single-pane console — this is exactly Alethia's V2-roadmap area, already real for Cloudfleet.
- **True hybrid/edge.** Joining any Linux box (on-prem, edge, Proxmox, Hetzner) into one cluster with a Tailscale overlay is a real differentiator Alethia doesn't match.
- **Lower friction free tier.** Free Basic cluster up to 24 vCPUs, no credit card, minute-level billing — easier to try than standing up the Alethia stack.
- **No control-plane ops burden.** Buyers who *want* someone else to run etcd/API servers get that turnkey; Alethia hands you ownership (and its responsibilities).

## How to position against them
"Cloudfleet rents you a Kubernetes **brain** that lives in *their* cloud and charges per vCPU to keep it there — and then leaves app delivery up to you. Alethia provisions a complete production platform **in your account** (cluster + data services + ArgoCD already wired to your Git repo) and lets you self-host the control plane itself — you own the brain *and* the body, with GitOps working out of the box." Lead with ownership + built-in GitOps + full-stack provisioning; concede day-2 maturity, hybrid/edge, and multi-cloud breadth today.

## Sources
- <https://cloudfleet.ai/> — product overview
- <https://cloudfleet.ai/docs/introduction/what-is-cloudfleet/> — architecture, managed control plane, node models, OIDC
- <https://cloudfleet.ai/docs/introduction/getting-started/> — cluster creation, AWS IAM/WIF + GCP WIF + Hetzner token, `kubectl` deploy flow
- <https://cloudfleet.ai/pricing/> — Basic/Pro/Enterprise tiers, CFCR, EUR pricing (as of 2026)
- <https://cloudfleet.ai/docs/organization/billing/> — billing model
- <https://cloudfleet.ai/compare/rancher/> — Cloudfleet's own "fully managed, we run the control plane" positioning
- <https://tailscale.com/customers/cloudfleet> — Tailscale-based networking, co-founder Yegor Tokmakov
- <https://www.g2.com/products/cloudfleet/competitors/alternatives> — third-party alternatives/positioning
- <https://slashdot.org/software/p/Cloudfleet-Kubernetes-Engine-CFKE/alternatives> — third-party CFKE alternatives listing
