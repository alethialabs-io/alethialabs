# Alethia vs Coolify

## Snapshot

Coolify is an open-source, self-hostable PaaS — a Heroku / Vercel / Netlify alternative that pushes container apps onto servers **you already own** over SSH. It is a community-driven project (originally built by Andras Bacsai), Apache-2.0 licensed, with ~57k GitHub stars and one of the largest self-hosted-PaaS communities. Model: free-forever self-hosted control panel, plus an optional managed "Coolify Cloud" hosting of the panel. It is a polished **container host**, not a cloud-infrastructure provisioner.

## How it works

- You install the Coolify control panel (a set of Docker containers) on a server, or let Coolify Cloud host the panel for you.
- You connect your own servers — VPS, bare metal, Raspberry Pi, an EC2 box — by giving Coolify an **SSH connection**. Coolify does not create those servers; you bring them.
- It deploys apps as containers using build packs: **Nixpacks** (auto-detects the stack and generates a Dockerfile), a custom **Dockerfile**, or **Docker Compose**. Plus 280+ one-click services (databases, tools, OSS apps).
- Deploy mechanism is **push-to-deploy**: connect a Git repo (GitHub App or deploy key), a push fires a webhook, Coolify rebuilds the image and redeploys the container. This is a **proprietary build/deploy pipeline**, not GitOps/ArgoCD.
- **What it does NOT do:** it does not provision cloud-native infrastructure. No EKS/GKE/AKS, no managed Aurora/RDS/ElastiCache/DynamoDB, no VPC/WAF/Route53/Secrets Manager. It runs Docker on Linux hosts you supply — there is no managed Kubernetes and no cloud control plane underneath.

## Pricing

- **Self-hosted:** free forever. Full features, no limits, runs on your own box.
- **Coolify Cloud:** $5/mo base, includes connecting up to 2 servers; +$3/mo per additional server; ~20% discount on annual billing. Cloud only hosts/manages the *panel* (backups, updates) — you still bring and pay for your own servers (Hetzner, DigitalOcean, AWS, etc.). It is BYOS (bring-your-own-server).

## Ownership & security model

- **Fully open-source and self-hostable** under Apache-2.0 with **no open-core split** — every feature is in the free, permissively-licensed core. This is genuinely Coolify's strongest position: maximum freedom to fork, modify, and run forever at no cost.
- **Credentials it holds:** SSH credentials to your servers and Git deploy keys / Git App tokens. It does **not** hold cloud-provider API keys, because it never brokers cloud infrastructure on your behalf — there is nothing to provision.
- **Lock-in: low.** Config lives on your servers; apps are standard Docker containers. If you leave Coolify you keep the containers (though not a portable GitOps/IaC definition of cloud infra, because none was ever created).

## Alethia vs Coolify

| Capability | Alethia | Coolify |
| --- | --- | --- |
| Own / self-host the control plane | Yes — self-host ~4 containers (AGPL) | Yes — self-host panel (Apache-2.0) |
| Zero stored cloud credentials | Yes — worker assumes cloud roles at runtime | N/A — holds SSH + Git keys, no cloud keys |
| Provisions cloud-native infra (EKS/Aurora/etc.) | Yes — EKS + Aurora + ElastiCache + DynamoDB + ECR + S3 + Secrets Manager + Route53 + WAF | No — deploys containers to servers you supply |
| App-delivery model | Standard GitOps — ArgoCD wired to your Git repo | Proprietary push-to-deploy build pipeline (Nixpacks/Dockerfile/Compose) |
| Multi-cloud | Yes — AWS / GCP / Azure | Indirect — any host you can SSH to; no cloud-native services |
| Open source | Yes — AGPL core + commercial `ee/` | Yes — Apache-2.0, no open-core split |
| Pricing | Self-host free; commercial EE/hosted tiers | Self-host free; Cloud from $5/mo (2 servers) |
| Day-2 ops maturity | Limited today (V2 console unbuilt) | Mature — logs, 1-click rollback, preview envs, audit logging |

## Where Alethia wins

- **Real cloud-native infrastructure in the user's own account:** a complete production cluster — managed Kubernetes (EKS) plus managed data services (Aurora, ElastiCache, DynamoDB) and the supporting stack (ECR, S3, Secrets Manager, Route53, WAF). Coolify can only run a Docker container and a self-managed database on a box you rent.
- **Zero-trust by design:** the control plane never stores cloud credentials; a remote worker assumes cloud roles at runtime. Coolify's model isn't about cloud at all, so it never solves this.
- **Standard, portable GitOps:** ArgoCD wired to the user's Git repo — apps deploy from a git push to a real, vendor-neutral, reproducible pipeline. Coolify's build/deploy is its own proprietary mechanism.
- **Multi-cloud, production-grade:** genuine AWS/GCP/Azure cloud architecture vs "anything you can SSH into."

## Where Coolify wins

- **Maturity and community:** years of production use, ~57k stars, and a very active ecosystem — Alethia is early.
- **280+ one-click services** and dead-simple DX: connect a server, push a repo, done. No cloud account, IAM, or VPC reasoning required.
- **A real day-2 console TODAY:** centralized logs, 1-click rollbacks, preview environments, audit logging — exactly the "Provision & Operate" experience that is still Alethia's *unbuilt* V2.
- **Genuinely free, with no open-core split:** every feature, forever, under a permissive license. Alethia gates orgs/SSO/RBAC/audit/multi-tenant behind commercial `ee/`.
- **Lowest barrier to entry:** runs on a $4 VPS; no managed-cloud bill or cloud expertise needed.

## How to position

Coolify is excellent if you want to host container apps on cheap VPS/bare-metal you already own, with a mature, friendly day-2 panel. Alethia is for teams that need **real, production AWS/GCP/Azure infrastructure they own** — managed Kubernetes plus managed data services, provisioned zero-trust into their own account and delivered via standard GitOps — not just a container host. Different jobs: Coolify hosts containers; Alethia hands you a production cloud cluster.

## Sources

- https://github.com/coollabsio/coolify
- https://coolify.io/pricing
- https://coolify.io/cloud
- https://coolify.io/docs/get-started/cloud
- https://coolify.io/docs/applications/build-packs/overview
- https://coolify.io/docs/applications/build-packs/docker-compose
- https://coolify.io/docs/applications/ci-cd/github/deploy-key
- https://coolify.io/changelog
- https://www.srvrlss.io/provider/coolify/
- https://temps.sh/blog/coolify-pricing-explained-2026
