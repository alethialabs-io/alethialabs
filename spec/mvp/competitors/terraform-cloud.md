# Alethia vs Terraform Cloud (HCP Terraform)

## Snapshot
HCP Terraform (formerly "Terraform Cloud," renamed April 2024) is HashiCorp's hosted IaC orchestration / remote-operations backend for Terraform: it runs `terraform plan`/`apply` remotely, stores state, gates changes with policy, and ties runs to your VCS. It is **not an app platform** — it provisions whatever HCL you write; it does not give you an opinionated cluster or wire up app delivery. Category: IaC orchestration / Terraform automation (TACOS). HashiCorp was founded 2012; acquired by **IBM for ~$6.4B**, deal completed **February 2025**. Business model: SaaS, priced per "Resources Under Management" (RUM); a self-hosted edition (Terraform Enterprise) is sold separately. (Sources below.)

## How it works
- **Hosted control plane by default.** Runs execute in HashiCorp's managed environment at `app.terraform.io`. State and variables (including secrets) live in HashiCorp's cloud unless you self-host TFE.
- **It orchestrates Terraform; it does not opinionate infra.** What gets provisioned is 100% whatever HCL/modules you author. There is no built-in "production EKS cluster + Aurora + ArgoCD" outcome — you'd have to write and maintain all of that yourself. HCP Terraform just plans/applies it and stores the state.
- **Deploy mechanism = Terraform runs triggered from VCS.** Connect a GitHub/GitLab/etc. repo to a workspace; a push to the tracked branch queues a run (plan, then gated apply). This is infra CI/CD, **not application GitOps** — there is no ArgoCD/Kustomize/Helm continuous-reconcile app-delivery loop. (Note: HashiCorp's "Waypoint templates / no-code provisioning" add an app-scaffolding layer on higher tiers, but it's proprietary, not standard GitOps.)
- **Execution: managed runners or self-hosted Agents.** By default runs happen in HashiCorp's environment. **HCP Terraform Agents** are pull-based self-hosted runners you deploy in your own network to reach private/on-prem infra — outbound-only, no inbound ingress. The orchestration/agent protocol is proprietary to HashiCorp.
- **Kubernetes:** HCP Terraform does not manage K8s as a product; it applies whatever EKS/GKE/AKS modules you write, same as any other resource.

## Pricing (as of June 2026)
Per-resource RUM model, billed on peak hourly managed-resource count across your state files:
- **Free** — up to **500 managed resources**, unlimited users, 1 policy set (≤5 policies). The legacy free plan ended **March 31, 2026**; orgs were moved to this enhanced Free tier. 500 resources is fine for tutorials but a single real EKS cluster + networking + IAM easily blows past it.
- **Essentials** — **$0.10 / resource / month** (~$0.00013/hr): remote state, VCS, projects, secure vars, private registry (10 modules).
- **Standard** — **$0.47 / resource / month**: + unlimited modules, no-code provisioning, Waypoint templates, team notifications.
- **Premium** — **$0.99 / resource / month**: + module revocation, Waypoint actions.
- **Terraform Enterprise (self-managed)** — custom/sales-quoted; adds no resource limits, audit logging, SAML SSO.
- Real-world math (third-party): ~1,000 resources ≈ **$470/mo** on Standard; 10,000 ≈ **$4,700/mo**. Resource counts often run 30–50% higher than expected (every IAM policy, SG rule, S3 lifecycle config counts).
- New HCP accounts get a **$500 IBM/HashiCorp Cloud credit**.

## Ownership & security model
- **Cloud credentials:** You can store static cloud keys in workspace variables (held in HashiCorp's cloud), **or** use **Dynamic Provider Credentials** — HCP Terraform mints an OIDC workload-identity JWT per run that your cloud trusts to hand back short-lived temp creds. With OIDC configured, no long-lived cloud keys are stored. This is a genuinely good zero-static-key story for the *runs*, but the orchestrator and state still live in HashiCorp's SaaS unless you buy TFE.
- **Self-host their control plane:** Yes, but only via the separate, sales-licensed **Terraform Enterprise** — deployable via Docker Compose, Kubernetes/Helm, OpenShift, Nomad, or Podman (Replicated install EOL April 2026). It is enterprise-priced, not a free self-host path.
- **Deploy pipeline portability:** The Terraform engine and HCL are portable/open; the **orchestration layer (workspaces, RUM, policy, agents, no-code/Waypoint) is proprietary** to HashiCorp. Migrating off HCP Terraform means re-homing state and rebuilding run/policy automation elsewhere (Spacelift, Scalr, env0, OpenTofu + CI).
- **Open source:** The HCP Terraform/TFE *platform is closed-source*. The Terraform CLI moved to the **BUSL** (non-open) license in Aug 2023, which spawned the OpenTofu fork (MPL). So neither the SaaS nor the modern CLI is OSI open-source.
- **Lock-in:** Moderate-to-high at the platform layer (RUM billing, proprietary policy/agent/no-code), low at the HCL layer.

## Alethia vs Terraform Cloud (HCP Terraform)

| Capability | Alethia | HCP Terraform |
| --- | --- | --- |
| Own / self-host the control plane | Yes — ~4 containers (Postgres + S3 + app + worker), AGPL | Only via separate, sales-priced Terraform Enterprise (Docker/K8s) |
| Zero stored cloud credentials | Yes — worker assumes roles at runtime; control plane never stores creds | Optional — static keys in SaaS *or* OIDC dynamic creds (no static keys); state/secrets still in HashiCorp SaaS by default |
| App-delivery model | Real ArgoCD wired to your Git repo, auto-sync (standard GitOps) | Infra CI/CD via VCS-triggered Terraform runs; no app GitOps (Waypoint is proprietary) |
| Self-host the platform | Yes, first-class and free (AGPL core) | Yes but enterprise-licensed (TFE) |
| Multi-cloud | AWS (EKS) today; GKE/AKS + Talos/k3s roadmap | Cloud-agnostic via any Terraform provider (broad) |
| Pluggable integrations | Cloudflare, Vault, Datadog/Grafana/Prometheus, Docker Hub, etc. | Vast Terraform provider/module ecosystem + VCS/Sentinel/OPA |
| Open source | AGPL core (+ commercial ee/) | No — platform closed; CLI is BUSL (OpenTofu is the OSS fork) |
| Pricing model | Self-host free; commercial tiers for orgs/SSO/multi-tenant | Per-resource RUM ($0.10–$0.99/resource/mo); Free ≤500 resources; TFE custom |
| Day-2 ops | Thin in V1; native console roadmap (V2) | Strong for IaC: drift detection, policy-as-code, audit, run history, state mgmt |

## Where Alethia wins
- **Outcome vs engine.** Alethia hands you a *complete, running production cluster* (EKS + Aurora/ElastiCache/SQS/ECR/Route53/WAF + operator suite + ArgoCD wired to Git) from one Spec. HCP Terraform gives you an orchestrator — you still have to write and own all that HCL yourself.
- **Real app GitOps, not just infra CI/CD.** Alethia wires standard ArgoCD to your repo so an app `git push` reconciles into the cluster. HCP Terraform's VCS trigger only re-applies infra; app delivery is out of scope (or proprietary Waypoint).
- **Free, first-class self-hosting.** Owning the Alethia control plane is the default AGPL path, not a separate six-figure SKU like Terraform Enterprise.
- **Truly open-source (AGPL).** Both the platform and the resulting stack are standard/portable; HCP Terraform's platform is closed and the CLI is BUSL.
- **No per-resource meter.** Alethia doesn't tax you $0.10–$0.99 per IAM policy / SG rule / S3 config; large estates don't trigger four-figure monthly RUM bills.

## Where HCP Terraform wins
- **Maturity, scale, and backing.** Decade-old product, IBM-owned (~$6.4B), used by a huge enterprise base — vastly more battle-tested than V1 Alethia.
- **IaC breadth.** Any Terraform provider/module for thousands of services across every cloud and SaaS — far broader than Alethia's curated AWS-first surface.
- **Day-2 IaC governance.** Mature drift detection, continuous validation, policy-as-code (Sentinel/OPA), audit logging, run/state history, RBAC, private module registry — areas Alethia's V1 only thinly covers.
- **Ecosystem and skills.** Terraform is an industry standard; the talent pool, modules, tutorials, and integrations are enormous.
- **Flexibility of scope.** It can manage *anything* expressible in Terraform, not just an opinionated K8s app-platform shape; for pure infra orchestration it's more general-purpose.

## How to position against them
"HCP Terraform is a *Terraform engine in HashiCorp's cloud* — it runs the HCL you still have to write and own, and meters you per resource. Alethia is the *outcome*: from one Spec, a worker stands up a complete, GitOps-wired production cluster in your own account — and you can self-host the whole Alethia control plane for free under AGPL, with zero stored cloud credentials. If you want infra plumbing you assemble yourself, use Terraform; if you want a running, owned app platform on day one, use Alethia (and keep Terraform underneath if you like)."

## Sources
- https://developer.hashicorp.com/terraform/cloud-docs — What is HCP Terraform (overview, remote runs, VCS, state)
- https://developer.hashicorp.com/terraform/cloud-docs/overview — Plans and features
- https://www.hashicorp.com/products/terraform/pricing — Tiers and RUM per-resource pricing
- https://scalr.com/learning-center/hcp-terraform-free-tier-is-being-discontinued-what-you-need-to-know — Free-tier EOL (Mar 31 2026), 500-resource cap, RUM math
- https://spacelift.io/blog/terraform-cloud-pricing — Tier/pricing third-party breakdown
- https://developer.hashicorp.com/terraform/enterprise — Terraform Enterprise = self-hosted distribution (SAML, audit, no limits)
- https://developer.hashicorp.com/terraform/enterprise/deploy — Flexible deployment (Docker/K8s/OpenShift/Nomad/Podman)
- https://www.hashicorp.com/en/blog/terraform-enterprise-adds-new-flexible-deployment-options — Flexible Deployment Options announcement
- https://developer.hashicorp.com/terraform/cloud-docs/dynamic-provider-credentials — OIDC dynamic provider credentials (no static keys)
- https://developer.hashicorp.com/terraform/cloud-docs/dynamic-provider-credentials/workload-identity-tokens — Workload identity JWT model
- https://spacelift.io/blog/terraform-cloud-agent — Self-hosted Agents (pull-based, outbound-only)
- https://spacelift.io/learn/scalr-vs-terraform-cloud — Lock-in / alternatives context
- https://www.sec.gov/Archives/edgar/data/0001720671/000114036124033293/ef20032487_ex99-1.htm — IBM–HashiCorp $6.4B acquisition (announced Apr 2024; closed Feb 2025)
