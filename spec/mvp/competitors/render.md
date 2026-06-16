# Alethia vs Render

## Snapshot

Render is a fully managed, git-push PaaS — the polished, modern "Heroku successor." You connect a Git
repo, Render builds and runs your code on **Render's own clusters** (their AWS/GCP footprint), and gives you
logs, metrics, rollbacks, preview environments, autoscaling, and managed Postgres/Redis with near-zero ops.
It is closed-source SaaS, very well funded (~$258M raised, $1.5B valuation, 4.5M+ developers), and arguably
the purest expression of "rent a black box on someone else's infrastructure."

Alethia is the opposite stance. It is open-source (AGPL core + `ee/`), self-hostable, multi-cloud, and
zero-trust. One Spec drives a remote worker that provisions a **complete production cluster in the user's own
cloud account** — EKS + Aurora + ElastiCache + DynamoDB + ECR + S3 + Secrets Manager + Route53 + WAF — then
installs ArgoCD wired to the user's Git repo, and hands over a cluster the user **owns**. The control plane
never stores cloud credentials; the worker assumes roles at runtime.

**One line:** Render is rent max-convenience compute on *their* metal; Alethia is own real production infra in
*your* cloud.

## How it works

- **Runs on Render's infrastructure, not yours.** Your services execute on Render-operated clusters. There is
  **no BYOC** (Bring Your Own Cloud) and no deploy-into-your-own-AWS-account mode. The only bridge to your own
  cloud is **AWS PrivateLink** connectivity (Pro workspace and up) so Render services can reach resources in
  your VPC, Snowflake, MongoDB Atlas, etc. — your *workloads* still live on Render's hardware.
- **Proprietary git-push pipeline.** Link a GitHub/GitLab/Bitbucket branch; every push triggers a Render build
  (auto-detected or custom build command) and a zero-downtime, health-checked deploy. `render.yaml`
  **Blueprints** are Render's IaC model — one YAML file declares the interconnected system (services, workers,
  cron, managed Postgres/Redis), and pushes that touch the Blueprint redeploy affected resources.
- **Closed, single managed footprint.** You cannot inspect, fork, or self-host the platform. There is no
  multi-cloud story — you take Render's managed footprint as given.

## Pricing

Render moved to flat **workspace plans + compute** in 2026 (per-seat billing removed):

- **Hobby** — $0/mo (usage only). Single team member, 25-service max, 5 GB bandwidth, 2 domains.
- **Pro** — **$25/mo flat** + compute. Unlimited members, SOC 2 / ISO 27001 reports, audit logs, 25 GB
  bandwidth, 15 custom domains, PrivateLink.
- **Scale** — **$499/mo flat** + compute. Adds Enterprise SSO, SCIM, advanced RBAC, HIPAA-enabled workspaces,
  multi-workspace management, 1000 GB bandwidth.
- **Enterprise** — custom pricing / contract.
- **Compute** is billed per service: web service instances run roughly **$7/mo (Starter, 512 MB)** up through
  the **hundreds of dollars per month** for the largest standard/pro instances, plus managed Postgres/Redis,
  bandwidth ($0.15/GB over included), and extra domains ($0.25/mo each).

Alethia provisions into the user's own cloud, so the user pays their cloud provider directly for EKS/Aurora/etc.
There is no Render-style platform margin on compute; Alethia's own control plane is self-hostable (~4 containers).

## Ownership & security model

Render is **maximum convenience, maximum lock-in**. You own *nothing* at the infrastructure layer: the
clusters, the network, the data plane, and the platform code all belong to Render. There is **no self-host
option** (closed-source SaaS), and migrating off means re-platforming (rebuild VPC, IAM, databases, CI/CD in
your own cloud — the standard "migrate from Render to AWS" exercise). Render holds the operational keys; you
get a clean DX in exchange for a black box you rent.

Alethia is the inverse: the provisioned cluster lives in the **user's own account**, the user owns every
resource and can keep running it even if Alethia disappears (git push → ArgoCD → deploy keeps working). The
**control plane never stores cloud credentials** — a worker assumes roles at runtime (zero-trust). The whole
Alethia control plane is AGPL and self-hostable as ~4 containers, so there is no platform-level lock-in.

## Alethia vs Render

| Dimension | Alethia | Render |
|---|---|---|
| Runs in YOUR cloud account | Yes — provisions into user's own AWS (EKS/Aurora/etc.) | No — runs on Render's clusters; no BYOC (PrivateLink to your VPC only) |
| Own / self-host the control plane | Yes — AGPL, ~4 containers, fully self-hostable | No — closed-source SaaS, cannot self-host |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime | N/A — Render operates the infra; it holds the keys |
| App-delivery model | Spec → real cluster + ArgoCD wired to your Git (git push → deploy) | git push → Render build; `render.yaml` Blueprints |
| Multi-cloud / BYOC | Yes — AWS/GCP/Azure, into user's account | No — single managed footprint on Render's cloud |
| Open source | Yes — AGPL core + `ee/` | No — proprietary |
| Pricing | User pays own cloud directly; control plane self-hostable | Hobby free; Pro $25/mo; Scale $499/mo; compute $7–$hundreds/service; Enterprise custom |
| Day-2 maturity | Earlier — V1 "Provision & Own," V2 "Provision & Operate" | Very mature — logs, metrics, rollbacks, preview envs, autoscaling, managed DBs |

## Where Alethia wins

- **You own a real cluster in your own account** — not a tenant on someone else's clusters. No re-platforming
  to leave; the infra is already yours.
- **Self-hostable, AGPL control plane** — Render cannot be self-hosted at all; Alethia can run entirely in the
  user's environment (~4 containers).
- **Zero-trust** — the control plane never stores cloud credentials; the worker assumes roles at runtime.
- **No lock-in** — git push → ArgoCD → deploy survives Alethia going away; the user keeps a standard EKS +
  ArgoCD stack.
- **Multi-cloud / BYOC** — AWS/GCP/Azure into the user's own account vs Render's single managed footprint.

## Where Render wins (be honest)

- **Maturity and polish** — years of refinement; the git-push DX, build pipeline, and Blueprints are smooth
  and battle-tested.
- **Funding and scale** — ~$258M raised, $1.5B valuation, 4.5M+ developers (250k+ joining monthly) — far more
  resources and proven reliability than an early-stage Alethia V1.
- **Day-2 DX out of the box** — logs, metrics, one-click rollbacks, per-PR preview environments, horizontal +
  vertical autoscaling, zero-downtime health-checked deploys, managed Postgres/Redis with storage autoscaling.
  Alethia V1 ("Provision & Own") does not yet match this operate-layer depth; that is V2's territory.
- **Zero-ops convenience** — no Terraform, no IAM, no cluster to babysit. For teams that want to ship and never
  think about infrastructure, Render is hard to beat.

## How to position

Render is the answer when convenience is the whole point: **rent maximum DX on Render's metal**, accept that
you own nothing and cannot self-host, and trade control for speed. Alethia is the answer for teams that must
**own and control** their infrastructure rather than rent it — regulated industries, security-sensitive orgs,
data-residency / sovereignty requirements, or anyone who refuses to hand cloud credentials to a third party or
run production on someone else's clusters. Alethia gives them a production cluster **in their own cloud, under
their own IAM, with an open-source control plane they can self-host** — the real thing they own, not a black
box they lease. Against Render specifically (the purest "black box on someone else's infra"), the contrast is
at its sharpest: **own your production infra vs. rent it.**

## Sources

- Render Series C extension — $100M at $1.5B valuation, 4.5M+ developers: https://render.com/blog/series-c-extension
- CNBC — Render raises $100M at $1.5B valuation: https://www.cnbc.com/2026/02/17/render-raises-100-million-at-1point5-billion-valuation.html
- New 2026 workspace pricing (Hobby/Pro/Scale, per-seat removed): https://render.com/blog/better-pricing-for-fast-growing-teams
- New Workspace Plans docs: https://render.com/docs/new-workspace-plans
- Platform features by plan: https://render.com/docs/platform-features-by-plan
- Render Blueprints (IaC) / `render.yaml`: https://render.com/docs/infrastructure-as-code
- Blueprint YAML reference: https://render.com/docs/blueprint-spec
- Deploying on Render (git-push pipeline): https://render.com/docs/deploys
- AWS PrivateLink connectivity (no BYOC, connect to your VPC): https://render.com/docs/private-link
- Preview environments: https://render.com/docs/preview-environments
- Render Pricing page: https://render.com/pricing
- Migrate from Render to AWS (lock-in / re-platforming context): https://encore.cloud/resources/migrate-render-to-aws
