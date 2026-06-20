# 01 — Product Vision

## Brand

**Alethia** by **Alethia Labs**. *A production app platform you own — not rent.*

> **One-liner:** Alethia provisions a complete, GitOps-wired Kubernetes platform on **your** cloud — zero stored credentials — and hands you a cluster you own. Your apps deploy from a `git push`; your databases, DNS, secrets, and registries are real cloud resources; your tools plug in.

## The problem

Getting from "we have an app" to "it runs in production on Kubernetes" forces a bad trade:

1. **The platform-engineering tax.** A real production cluster — networking, databases, caching, DNS, secrets, registries, autoscaling, GitOps — is weeks of Terraform/Helm/YAML. Every team rebuilds the same wheel.
2. **Rent a black box, or build it yourself.** The app PaaS that saves you the weeks (Porter, Qovery, Northflank) makes you **hand them your cloud keys**, runs your control plane on **their** servers, and locks your deploys into **their** abstraction. The DIY route (Terraform + ArgoCD by hand) keeps ownership but brings back the tax.
3. **Credential leakage.** Both paths leak long-lived cloud keys and admin kubeconfigs into CI and third-party SaaS — the thing every audit flags.

## What Alethia is

Alethia gives you the **real thing**, provisioned for you, that **you own**. One **Spec** (your infrastructure design) → a remote **runner** provisions it in *your* cloud account, assuming roles **at runtime** so no credentials are ever stored, and hands you a complete, self-managing, GitOps-wired cluster.

### What you actually get (verified, end-to-end)

A single deploy provisions and wires the whole platform:

- **Cluster + network:** managed Kubernetes (EKS today; GKE/AKS + self-managed Talos/k3s on the roadmap) on a VPC with public/private subnets, security groups, IAM/IRSA, optional Karpenter autoscaling.
- **Data + ops services:** Aurora PostgreSQL, ElastiCache Redis, DynamoDB, SQS/SNS, ECR, S3, Secrets Manager (KMS-encrypted), Route 53 + ACM, optional WAF.
- **GitOps, wired — not just installed.** ArgoCD is installed **and connected to your Git repo** with auto-sync (prune + self-heal). Push to your repo → your apps deploy and stay reconciled. From day one.
- **A real operator suite** via app-of-apps: external-secrets, external-dns, AWS load-balancer-controller, Karpenter, metrics-server, a default storage class.
- **The handoff:** cluster endpoint + kubeconfig, ArgoCD URL + admin access, and every database/cache endpoint — all in your dashboard. It's **your** cluster in **your** account. Alethia doesn't sit in the data path.

## The four pillars

1. **Zero-trust remote provisioning.** The runner assumes cloud roles at execution time; the control plane never sees or stores your keys.
2. **Own it / self-hostable.** You own the cluster — and you can self-host the Alethia control plane itself as ~4 containers (no SaaS dependency). ([06-self-hosting-architecture](06-self-hosting-architecture.md))
3. **GitOps app-delivery.** A real cluster + ArgoCD wired to your repo, using standard Kustomize/Helm — not a proprietary deploy pipeline you can't leave.
4. **Pluggable integrations + multi-cloud.** Bring your own tools per category (Cloudflare DNS, Vault, Datadog/Grafana/Prometheus, Docker Hub) across many clouds. ([08-integrations-extensibility](08-integrations-extensibility.md), [09-multi-cloud-cluster-strategies](09-multi-cloud-cluster-strategies.md))

## Positioning — the anti-Porter

Porter/Qovery/Northflank **rent** you a proprietary PaaS: they hold your keys, run your control plane, and lock your deploys into their black box. **Alethia hands you the real, standard thing — EKS + ArgoCD + your own tools — provisioned zero-trust, and you own all of it.** Same outcome (production app platform, fast), opposite ownership model. Full landscape: [03-competitive-positioning](03-competitive-positioning.md).

## Release trajectory

- **V1 — "Provision & Own"** (launch). Deliver the complete, GitOps-wired cluster you own; the app experience **is** ArgoCD (standard, yours). The Alethia dashboard adds a thin **visibility** layer — sync status, cost, health — over what you own. Plus the integration-catalog breadth. This is the sharp, shippable wedge: be the anti-Porter.
- **V2 — "Provision & Operate."** Climb into an Alethia-native day-2 experience — deploys, logs, rollbacks, preview environments, ongoing cluster management — rivaling Porter's polish, while staying self-hostable and zero-trust. Same ownership promise, fuller DX.

## Open source & business model

**AGPL-3.0**, open-core. The self-hostable core (provisioning + GitOps + integrations + single-tenant + community RBAC) is free and complete. Organizations/SSO/RBAC-at-scale/audit/multi-tenancy + hosted SaaS are the commercial `ee/` tier. ([12-licensing-open-core](12-licensing-open-core.md), [14-gtm-pricing](14-gtm-pricing.md))

## What Alethia is NOT

- **Not a rented PaaS** — it doesn't hold your keys or run your control plane; you own the cluster (and can self-host Alethia).
- **Not a proprietary deploy pipeline** — app-delivery is GitOps (ArgoCD + your repo), standard and portable.
- **Not your source host or CI** — your Git + CI build images; Alethia provisions the platform they run on.
- **Not single-cloud, not single-vendor** — multi-cloud, multi-strategy, integrations of your choice.
- **(V1) Not a day-2 ops console** — that's V2; V1 hands you a self-managing cluster with thin visibility.
