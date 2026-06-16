# Alethia vs Dokploy

## Snapshot

**Dokploy** is an open-source, self-hostable Platform-as-a-Service — a Heroku/Vercel/Netlify
alternative you run on your own VPS. It deploys apps as containers via Docker, fronts them with
Traefik for automatic HTTPS, and clusters multiple machines with Docker Swarm. Install is a single
`curl | bash` line; from there you get a polished UI for app deploys, databases, backups, preview
environments, monitoring, and one-click templates. The core is Apache-2.0, with a published
open-core plan: future enterprise features land in a source-available `proprietary/` directory.
It has ~35k GitHub stars and a mature day-2 experience.

**Alethia** is an AGPL, self-hostable, multi-cloud, **zero-trust Kubernetes platform**. From one Spec,
a remote worker provisions a *complete production cluster in the user's own cloud account* — EKS +
Aurora + ElastiCache + DynamoDB + ECR + S3 + Secrets Manager + Route53 + WAF — and installs ArgoCD
wired to the user's own Git repo (git push → deploy). The user ends up owning real cloud-native
infrastructure. The control plane never stores cloud credentials; the worker assumes roles at runtime.

The fundamental difference: **Dokploy gives you a great PaaS *on a server you already rent*. Alethia
gives you a *real cloud-native cluster you own*, provisioned for you, with no creds held by the platform.**

## How it works

- **Orchestrator: Docker Swarm**, not Kubernetes. Apps run as Swarm services on Docker; Traefik
  handles ingress/TLS. No EKS, no Kubernetes-native primitives, no Helm/operators ecosystem.
- **App delivery: a proprietary PaaS build/deploy pipeline.** Dokploy builds images with
  Nixpacks, Heroku/Cloud Native Buildpacks, Railpack, raw Dockerfiles, or Docker Compose, then
  rolls them onto Swarm. Git integration auto-deploys on push — but through Dokploy's own pipeline,
  **not standard GitOps/ArgoCD reconciliation**.
- **No cloud-native provisioning.** Dokploy does **not** stand up EKS, Aurora, ElastiCache, etc. Its
  managed databases (Postgres/MySQL/MariaDB/MongoDB/Redis) are *containers on your servers*, not AWS
  managed data services. You bring servers; it deploys onto them.
- **Bring-your-own-server via SSH.** The control plane manages remote machines over SSH + the remote
  Docker API. Add a server by giving it an IP/port and an SSH key (RSA or Ed25519); Dokploy installs
  Docker, Traefik, and a monitoring agent automatically.

## Pricing

- **Self-hosted: free** (Apache-2.0 core). Run the whole thing on a single ~$5 VPS.
- **Cloud — Hobby:** $4.50/mo per server (1 server, 1 org, 1 user, 2 environments; 20% off yearly).
- **Cloud — Startup:** from $15/mo (3 servers, unlimited users/environments, basic RBAC, 2FA);
  additional servers $4.50/mo each.
- **Cloud — Enterprise:** custom — fine-grained RBAC, SSO/SAML, audit logs, white-labeling,
  MSA/SLA, and a *self-hosted* enterprise option "on-prem or in your own cloud."
- Billing is **per-server**, not usage/dyno-based.

## Ownership & security model

- **Strong OSS / self-host story.** Apache-2.0 core is freely usable, modifiable, and resellable;
  full self-host means **no vendor lock-in** for the deployment layer and low switching cost (it's
  just Docker/Compose underneath).
- **Open-core caveat:** advanced enterprise features (SSO, HA, advanced monitoring, white-labeling)
  move to a source-available `proprietary/` license requiring paid licensing in production.
- **Credential surface: SSH keys.** Dokploy Cloud holds SSH keys/root access to your servers to
  manage them — a real trust surface if you use the managed control plane. **Self-hosting avoids
  this**, since the keys stay on your own Dokploy instance. Either way it's host-level SSH access,
  a coarser blast radius than scoped, runtime-assumed cloud roles.

## Alethia vs Dokploy

| Capability | Alethia | Dokploy |
|---|---|---|
| Own / self-host the control plane | Yes (~4 containers) | Yes (1-line install) |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime | No — Cloud holds SSH keys (self-host avoids) |
| Provisions cloud-native infra | Yes — EKS, Aurora, ElastiCache, DynamoDB, ECR, S3, Secrets Mgr, Route53, WAF | No — deploys containers to existing servers |
| Orchestrator | Kubernetes (EKS) | Docker Swarm |
| App-delivery model | Standard GitOps via ArgoCD wired to user's repo | Proprietary PaaS pipeline (Nixpacks/buildpacks/Dockerfile/Compose) |
| Multi-cloud | Yes (AWS today; GCP/Azure templates) | Cloud-agnostic VPS, but no cloud-native provisioning |
| Open source | AGPL core + `ee/` | Apache-2.0 core + source-available `proprietary/` |
| Pricing | OSS self-host; hosted/EE tier | Free self-host; Cloud from $4.50/mo/server, Startup from $15/mo |
| Day-2 maturity | Earlier (V1 Provision & Own → V2 Operate) | Mature — previews, rollbacks, backups, monitoring, templates |

## Where Alethia wins

- **Real Kubernetes + managed AWS data services in the user's own account.** Alethia hands over an
  EKS cluster with Aurora, ElastiCache, DynamoDB, S3, ECR, Secrets Manager, Route53, and WAF —
  production-grade, scalable, native AWS infra. Dokploy gives Swarm services and *containerized*
  databases on a VPS you must size and operate yourself.
- **Zero-trust architecture.** The control plane never stores cloud credentials; the worker assumes
  scoped roles at runtime. Dokploy's managed control plane holds SSH/root keys to your servers.
- **Standard GitOps.** ArgoCD wired to the user's repo means deploys reconcile through an
  industry-standard, auditable, portable tool — not a vendor-specific pipeline you can't lift out.
- **Multi-cloud & true ownership.** The cluster lives in the user's account and survives Alethia; it's
  a real, portable Kubernetes estate, not infrastructure coupled to one PaaS's runtime.

## Where Dokploy wins (be honest)

- **Maturity and DX, today.** ~35k stars, a battle-tested UI, and a genuinely polished day-2
  experience: preview environments, instant rollbacks, automated DB/volume backups, built-in
  monitoring/alerts, and one-click app templates. Alethia's V1 is "Provision & Own" — operate (V2) is
  still ahead.
- **Near-zero ops and cost.** A single $5 VPS plus a `curl | bash` and you're deploying. No AWS bill,
  no Kubernetes to operate, no cloud-account complexity. For hobbyists, side projects, and small
  teams, that's a lower barrier than standing up EKS + Aurora + the rest.
- **Free, lock-in-light self-host.** Apache-2.0 (more permissive than AGPL), and the underlying
  Docker/Compose substrate is trivial to leave.

## How to position

Alethia is not a "better Dokploy" — it's a different category. Dokploy is the right answer when the
goal is *cheap, simple app hosting on a box you rent*, with great DX and minimal ops. Alethia is the
right answer when the user needs to **own a real, production, cloud-native Kubernetes platform in
their own account** — EKS plus managed AWS data services, zero-trust credential handling, and
standard GitOps — without renting a black box (the anti-Porter pitch: *own the real thing*).
Lead with: cloud-native infra ownership, zero stored credentials, and portable GitOps. Concede
Dokploy's day-2 maturity and frame Alethia's roadmap (V1 Provision & Own → V2 Provision & Operate) as
the path to closing that gap on top of infrastructure Dokploy structurally cannot provision.

## Sources

- Dokploy site / overview: https://dokploy.com/ and https://dokploy.com/self-hosted-paas
- Pricing: https://dokploy.com/pricing
- License update (Apache-2.0 + open-core / source-available `proprietary/`): https://dokploy.com/blog/we-are-updating-dokploys-open-source-license
- GitHub repo (~35k stars, Docker Swarm + Traefik, install script): https://github.com/Dokploy/dokploy
- Remote servers / SSH model: https://docs.dokploy.com/docs/core/remote-servers and https://docs.dokploy.com/docs/core/ssh-keys
- Multi-server deployment: https://dokploy-dokploy.mintlify.app/infrastructure/multi-server
- Dokploy Cloud docs: https://docs.dokploy.com/docs/core/cloud
- Independent review (features/pricing): https://www.srvrlss.io/provider/dokploy/
