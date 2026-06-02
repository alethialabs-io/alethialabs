# Product Vision

## Brand

**Trellis** — Enterprise Infrastructure, Cultivated.

The canonical product name is **Trellis**. All marketing, landing page copy, and pitch materials lead with "Trellis." The codebase reference "ADP ItGix Platform" is an internal/academic identifier and should not appear in user-facing content.

---

## One-Liner

> Configure multi-cloud infrastructure in the browser. Deploy from the terminal. Git is the source of truth.

---

## Tagline

> Trellis — Enterprise Infrastructure, Cultivated.

---

## The Problem

Cloud infrastructure provisioning is broken in three specific ways:

### 1. Slow Onboarding
Getting a production Kubernetes cluster with networking, databases, caching, messaging, DNS, secrets management, and GitOps takes weeks of boilerplate Terraform, Helm, and YAML. Every team reinvents the same wheel.

### 2. Security Theater
CI/CD pipelines demand static credentials — long-lived IAM keys, admin kubeconfigs, service account JSON files. These credentials leak, get over-permissioned, and violate every compliance framework. Teams know it's wrong but have no alternative.

### 3. Black-Box Deployments
Once infrastructure is provisioned, developers have no visibility into what's running, what it costs, or what state it's in. Terraform state files sit in S3 buckets nobody reads. Cost surprises arrive at month-end.

---

## The Solution

Trellis attacks all three problems with a platform built around three pillars:

### 1. Visual Configuration
An 11-section guided form lets you design complete infrastructure visually — networking, Kubernetes clusters, databases, caches, NoSQL, messaging, DNS, secrets, container registries, and Git repositories. A real-time cost sidebar shows the monthly estimate as you configure. No YAML. No HCL. No guesswork.

### 2. Zero-Credential Security
Trellis never stores static cloud keys. Instead:
- **AWS**: Cross-account IAM roles with External ID — the worker assumes your role at execution time
- **GCP**: Workload Identity Federation — OIDC token exchange, no service account keys
- **Azure**: Federated Identity — app registration with OIDC, no client secrets

The control plane is decoupled from the execution plane. Your credentials never leave your cloud account.

### 3. GitOps by Default
ArgoCD is bootstrapped automatically during cluster creation. Git becomes the audit trail. Infrastructure changes flow through plan-review-apply, not ad-hoc `kubectl apply`. The platform generates real Terraform and Helm — you own everything it creates.

---

## The Viticulture Lexicon

The platform uses a viticulture (winemaking) metaphor that makes infrastructure memorable and less intimidating:

| Term | Infrastructure Concept | Component |
|------|----------------------|-----------|
| **Trellis** | Web control plane | `apps/trellis/` — Next.js dashboard |
| **Grape** | CLI tool + headless worker | `apps/grape/` — Go binary |
| **Vintner** | Documentation site | `apps/vintner/` — Fumadocs |
| **Vineyard** | Workspace / project boundary | Logical grouping of vines |
| **Vine** | Infrastructure configuration | A complete set of cloud resources |
| **Harvest** | Provisioning run / deployment | Executing a vine's Terraform |
| **Plant a Vine** | Design new infrastructure | The 11-section configuration form |
| **Estate Map** | Infrastructure topology view | React Flow visualization |

### Deprecated terms
- **Tendril** — was the in-cluster agent concept. Replaced by the Grape Worker pull model. Retained only as historical reference in documentation.

---

## Target Audience

### Primary: Platform Engineers & DevOps Teams
Mid-market companies (50-500 engineers) where a small platform team serves many application teams. They need to provide self-service infrastructure without giving everyone Terraform access or admin credentials.

### Secondary: Individual Developers
Solo developers or small teams managing their own cloud infrastructure. They want production-quality EKS/GKE/AKS without the weeks of boilerplate.

### Tertiary: Engineering Leadership
CTOs and VPs evaluating build-vs-buy for internal developer platforms. They care about security posture, cost visibility, and time-to-production.

---

## Multi-Cloud Story

Trellis supports AWS, GCP, and Azure with feature parity across:
- 12 infrastructure service categories (see feature inventory)
- Provider-specific authentication (IAM roles, WIF, federated identity)
- Native service names and configurations per cloud
- One form, three clouds — switch providers with the provider ribbon

This is not an abstraction layer that hides the cloud. Trellis generates cloud-native Terraform that uses each provider's best services (Aurora, not a generic "database"; EKS with Karpenter, not a generic "cluster").

---

## Open Source

Trellis is open source. The entire platform — web control plane, CLI, worker, documentation — is available on GitHub.

**Made by Borislav Borisov. Open Source.**

---

## What Trellis Is NOT

- **Not a managed Kubernetes provider.** You own your clusters in your cloud accounts.
- **Not a CI/CD platform.** Trellis provisions infrastructure, not application code.
- **Not a YAML abstraction layer.** It generates real Terraform and Helm that you can read, modify, and own.
- **Not a hosted service that holds your keys.** The zero-credential model means your secrets stay in your cloud.
