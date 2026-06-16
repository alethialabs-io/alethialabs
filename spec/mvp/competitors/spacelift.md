# Alethia vs Spacelift

## Snapshot

Spacelift is an **IaC orchestration platform** — a CI/CD control plane for infrastructure-as-code. You point it at a Git repo full of Terraform / OpenTofu / Pulumi / CloudFormation / Terragrunt / Ansible / raw Kubernetes manifests, and it runs plan/apply pipelines with policy-as-code (OPA/Rego), drift detection, state management, and an approval/collaboration layer on top. It does **not** ship you a production cluster or an opinionated app platform — it orchestrates whatever IaC *you* write.

- **Category:** IaC orchestration / Terraform-Cloud-style runner (TACOS — "Terraform Automation and Collaboration Software").
- **Founded:** 2020. HQ: Redwood City, CA (engineering in Warsaw, Poland). Founding member of the OpenTofu project.
- **Funding:** ~$73.6M raised across 4 rounds (Series B was $15M led by Insight Partners, 2021; additional rounds since). Investors include Insight Partners, Blossom Capital, Hoxton Ventures, Inovo. Well-funded, established mid-market vendor.
- **Business model:** SaaS control plane priced by workers (concurrency) + users + tiers; self-hosted edition for the top Enterprise tier.

## How it works

- **Hosted control plane by default.** Spacelift runs the orchestration/state/UI/policy plane as SaaS. You connect a VCS (GitHub/GitLab/Bitbucket/Azure DevOps); Spacelift watches the repo and triggers **runs** (a "run" previews or changes infra) against **stacks** (repo + state + config).
- **BYOC compute via private worker pools.** Runs execute on either Spacelift's shared public workers or **private worker pools you deploy in your own cloud** (EC2 ASG, Docker, or Kubernetes). With private workers the code, state payload, and credentials never touch Spacelift's compute — run state is end-to-end encrypted and only your workers hold the private key.
- **What it provisions vs deploys:** Spacelift is tool-agnostic plumbing. It provisions *whatever your Terraform/Pulumi/etc. declares* — it does not give you a curated cluster + Aurora + ArgoCD + operator suite out of the box. You bring (and maintain) all the IaC yourself.
- **Deploy mechanism:** standard IaC runs (not a proprietary container PaaS, not GitOps-to-cluster by default). It can run Kubernetes manifests as a stack, but it is *not* an ArgoCD/Flux GitOps controller wired into a live cluster — it's a CI runner that applies on git push with gates.
- **Kubernetes:** managed only insofar as your IaC manages it (EKS/GKE/AKS via Terraform, or k8s-manifest stacks). No managed app-delivery, no cluster ownership handoff, no operator install.

## Pricing

_As of June 2026 — see Sources; some tier figures are list/estimate and Spacelift quotes most tiers custom._
- **Free** — $0. ~2 users, public workers only, up to ~200 managed resources. ([spacelift.io/pricing](https://spacelift.io/pricing))
- **Starter** — published at **$399/month**, 10 users, 2 public workers, policy-as-code, private module registry, OIDC, webhooks. ([scalr.com](https://scalr.com/learning-center/spacelift-alternatives), [spacelift.io/pricing](https://spacelift.io/pricing))
- **Starter+** — unlocks **drift detection + private worker pools**; list/estimate around **$20k/year** (annual). ([spacelift.io/pricing](https://spacelift.io/pricing))
- **Business** — custom quote; blueprints/templates, advanced scheduling, private provider registry, more private workers.
- **Enterprise** — custom quote; **SSO/SAML, audit trail, OIDC API keys, MFA**.
- **Enterprise+** — custom quote; **self-hosted / on-prem / air-gapped, FedRAMP**.
- **Model:** priced primarily by **workers (parallel run concurrency)** + users + tier, plus managed-resource limits — not pure usage-based.

## Ownership & security model

- **Stored cloud credentials? No (this is a real strength they share with Alethia).** The AWS/GCP/Azure integrations use **dynamic, short-lived credentials via AssumeRole / OIDC** generated at run time. With private workers, "those credentials are never leaked to us in any shape or form" — temporary creds (1h default) live only on your worker and are never persisted by Spacelift. So on the **zero-stored-credentials pillar, Spacelift matches Alethia** when private workers are used.
- **Self-host THEIR control plane? Only at the top Enterprise+ tier.** Self-hosted/air-gapped Spacelift exists but is gated behind the most expensive, custom-quoted plan — not the default and not open to small teams.
- **Deploy pipeline portability:** good — your assets are standard Terraform/OpenTofu/Pulumi in your own Git repo. The *orchestration, policies, stack config, RBAC, state backend, and run history* live in Spacelift, so there's meaningful workflow lock-in even though the underlying IaC is portable.
- **Open source? No (core is proprietary SaaS).** Only the **private worker image** is open source (for transparency). Spacelift the platform is closed. (They co-founded OpenTofu, but that's a separate project.)
- **Lock-in:** moderate — IaC files are yours, but stacks, Rego policies, blueprints, drift config, and the whole control plane are Spacelift's.

## Alethia vs Spacelift

| Capability | Alethia | Spacelift |
| --- | --- | --- |
| Own/self-host the control plane | Yes — ~4 containers (Postgres+S3+app+worker), no SaaS dependency | Self-hosted only at Enterprise+ (top custom tier); SaaS otherwise |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime | **Yes** — AssumeRole/OIDC, short-lived creds, private workers (parity) |
| App-delivery model | Real cluster + **ArgoCD wired to your Git repo** (GitOps auto-sync) | IaC runs on git push; **not** a GitOps-to-cluster controller / no app PaaS |
| Self-host the platform | Yes (AGPL core) | Partial — gated to Enterprise+ |
| Multi-cloud | AWS now; GCP/Azure + Talos/k3s roadmap | Broad — any cloud your IaC targets (AWS/GCP/Azure/on-prem) |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub, ECR | Deep VCS + cloud + Slack + OPA + many IaC tools |
| Open source | Yes (AGPL core, commercial ee/) | No — proprietary core; only worker image OSS |
| Pricing model | Self-host = own infra cost; commercial tiers | Workers (concurrency) + users + tier; Free → $399/mo → custom |
| Day-2 ops | V1 thin dashboard; native console is V2 (roadmap) | Mature — drift detection, policies, run history, RBAC, audit |

## Where Alethia wins

- **Delivers an outcome, not plumbing.** One Spec → a complete production cluster (EKS + Aurora/ElastiCache/DynamoDB/SQS-SNS/ECR/S3/Secrets-Manager/Route53/WAF) + ArgoCD + operator suite, handed to you. Spacelift only runs IaC *you* must author and maintain — there's no batteries-included cluster.
- **Real GitOps app-delivery wired to your repo.** Alethia installs ArgoCD and connects it to your Git for auto-sync app deploys. Spacelift is a CI runner that applies IaC on push — not a live ArgoCD/Flux GitOps loop and not an app platform.
- **Self-hostable control plane for everyone.** Alethia's whole control plane is AGPL and runs as a handful of containers. Spacelift's self-hosted edition is locked behind its most expensive, custom-quoted Enterprise+ tier.
- **Fully open source.** AGPL core vs Spacelift's proprietary SaaS (only the worker is OSS).
- **You own the artifact.** Alethia hands over kubeconfig + ArgoCD URL + endpoints to a cluster you fully own; Spacelift owns the orchestration plane your workflows depend on.

## Where Spacelift wins

- **Maturity, funding, and breadth.** ~$73.6M raised, 5+ years in market, thousands of users; supports Terraform, OpenTofu, Pulumi, CloudFormation, Terragrunt, Ansible, and Kubernetes in one place. Alethia is pre-V1 and AWS/EKS-only today.
- **Day-2 operations are real today.** Drift detection, scheduled reconciliation, policy-as-code (OPA/Rego) at every stage, run history, RBAC, audit trails, blueprints/templates — Alethia's equivalent console is a V2 roadmap item.
- **Tool-agnostic governance.** It governs *any* IaC against *any* cloud (incl. on-prem, GovCloud, FedRAMP, air-gapped) — far broader surface than Alethia's curated EKS stack.
- **Credential model is already best-in-class.** Dynamic AssumeRole/OIDC with private workers means Spacelift does **not** undercut Alethia on the zero-trust pillar — this is genuine parity, not a weakness to attack.
- **Multi-cloud and on-prem today**, including air-gapped and FedRAMP, which Alethia cannot match yet.
- **Polished collaboration/UX** around runs, approvals, and stacks — a refined product, not a V1.

## How to position against them

"Spacelift orchestrates the Terraform *you still have to write and own* — it's a CI control plane for IaC, not a platform. Alethia gives you the finished outcome: one Spec provisions a complete, GitOps-wired production cluster you fully own, and you can even self-host the entire Alethia control plane (AGPL, ~4 containers) — not just rent a closed SaaS that holds your stacks, policies, and run history." Don't attack their credential model (they match us); attack that they hand you *more IaC to maintain* and a *proprietary, mostly-SaaS* control plane, while Alethia hands you a running, owned platform.

## Sources

- Spacelift homepage / platform — https://spacelift.io/ , https://spacelift.io/platform/how-it-works
- Pricing — https://spacelift.io/pricing
- AWS integration (dynamic AssumeRole/OIDC, creds never stored) — https://docs.spacelift.io/integrations/cloud-providers/aws
- Security & worker pools — https://docs.spacelift.io/product/security , https://docs.spacelift.io/concepts/worker-pools
- Self-hosted edition — https://spacelift.io/blog/introducing-spacelift-self-hosted
- Funding (Series B $15M, Insight Partners) — https://spacelift.io/blog/spacelift-raises-15m , https://www.insightpartners.com/ideas/spacelift-raises-15m-in-series-b-funding-from-insight-partners-to-scale-its-platform-in-the-us/
- Total funding (~$73.6M) — https://tracxn.com/d/companies/spacelift/funding-and-investors
- Third-party comparison & pricing corroboration — https://scalr.com/learning-center/spacelift-alternatives , https://www.vendr.com/marketplace/spacelift
