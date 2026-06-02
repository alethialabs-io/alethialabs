# Competitive Positioning

## Market Category

Trellis sits at the intersection of two categories:
- **Internal Developer Platform (IDP)** — self-service infrastructure for application teams
- **Infrastructure Configuration Platform** — visual configuration that generates real IaC

It is NOT a managed Kubernetes provider, CI/CD platform, or YAML abstraction layer.

---

## Competitive Landscape

| Capability | Trellis | Terraform Cloud | Spacelift | Pulumi Cloud | Env0 | Port (getport.io) |
|-----------|---------|----------------|-----------|-------------|------|-------------------|
| Visual configuration UI | 11-section guided form with real-time cost | None (HCL only) | None (HCL/OpenTofu) | None (code only) | None (HCL only) | Portal builder (no infra form) |
| CLI with interactive TUI | Charmbracelet forms, 6-step wizard | Basic `terraform` CLI | Basic CLI | `pulumi` CLI | None | None |
| Multi-cloud feature parity | AWS/GCP/Azure with native service mapping | Provider-agnostic (user writes HCL) | Provider-agnostic | Provider-agnostic | Provider-agnostic | Provider-agnostic |
| Zero-credential security | IAM roles, WIF, federated identity — no static keys | Stored credentials or dynamic providers | Stored credentials | Stored credentials | Stored credentials or OIDC | Depends on integration |
| Pre-deploy cost estimation | Real-time sidebar + Infracost | Sentinel policies (paid) | Infracost integration | None native | Infracost integration | None |
| GitOps bootstrapped by default | ArgoCD auto-installed | None | None | None | None | Optional via blueprints |
| Per-component status tracking | 12 component tables, individual status per resource type | All-or-nothing state | Stack-level status | Stack-level status | Run-level status | Entity-level (manual) |
| Open source | Full platform | OSS engine, proprietary cloud | Proprietary | OSS engine, proprietary cloud | Proprietary | Proprietary |
| Generates real Terraform | Terraform + Helm, user owns output | User writes Terraform | User writes Terraform | User writes code | User writes Terraform | Scaffolding templates |
| Worker-based execution | Fargate workers in user's account | Remote runners | Worker pools | Deployments service | Agents | Self-hosted runners |

---

## Key Differentiators

### 1. "Configure in the browser, deploy from the terminal"

No other tool gives you both a visual configuration UI and a full-featured interactive CLI that share the same state. Terraform Cloud has a UI but it's for managing runs, not designing infrastructure. Port has a portal builder but no infrastructure-specific form. Trellis lets you design infrastructure visually in 11 guided sections, then deploy it with `grape harvest` from your terminal.

### 2. Zero-Credential Security (The Pull Model)

Traditional platforms demand you give them cloud credentials:
- Terraform Cloud: "Store your AWS access key" or configure dynamic providers
- Spacelift: "Give us an IAM role with admin access"
- Env0: "Store credentials in our vault"

Trellis flips the model. The worker runs in YOUR cloud account and assumes roles at execution time. The control plane never sees or stores cloud credentials. Short-lived sessions, scoped permissions, nothing to leak.

### 3. GitOps by Default, Not by Configuration

Every other tool treats GitOps as an add-on you configure yourself. Trellis bootstraps ArgoCD automatically during cluster creation. Git becomes the audit trail from day one. When you modify a vine and apply, the change flows through Terraform → Helm → ArgoCD reconciliation.

### 4. Cloud-Native, Not Cloud-Agnostic

Pulumi and Terraform are "write once, deploy anywhere" — but that means your Aurora database becomes a generic `aws_rds_cluster` you have to configure from scratch. Trellis knows that AWS has Aurora with Karpenter, GCP has Cloud SQL with Autopilot, and Azure has Azure Database. The form shows you the right options for each cloud. The output is cloud-native Terraform, not a lowest-common-denominator abstraction.

### 5. Real-Time Cost Awareness

Trellis shows you the monthly cost impact as you configure, not after you deploy. The cost sidebar updates with every form change — add a database, see the cost jump. Switch from `db.r6g.large` to `db.r6g.xlarge`, see the difference immediately. This prevents cost surprises before they happen.

---

## What Trellis Replaces

| Current Approach | Pain | Trellis Alternative |
|-----------------|------|-------------------|
| Hand-written Terraform modules | Weeks of boilerplate, every team reinvents the wheel | 11-section form generates production Terraform in minutes |
| Static IAM keys in CI/CD secrets | Keys leak, get over-permissioned, violate compliance | Cross-account roles assumed at runtime, no static keys |
| Separate cost estimation (Infracost post-plan) | Cost surprises at month-end | Real-time cost sidebar during configuration |
| Manual ArgoCD setup | Half-day of Helm values, RBAC, and Git repo wiring | ArgoCD bootstrapped automatically |
| Spreadsheet-based infra tracking | No real-time status, manual updates | Per-component status tracking across 12 resource types |
| Confluence/Notion architecture docs | Stale on day two | Live dashboard with infrastructure topology |

---

## Target Use Cases

### 1. Startup Scaling (1 → 10 Microservices)
Your first production EKS/GKE cluster with databases, caching, and GitOps — done in 20 minutes instead of 2 weeks. Cost-aware from day one.

### 2. Enterprise Self-Service
Platform team defines guardrails. Application teams plant their own vines. No Terraform expertise needed. Security team is happy because no static credentials exist.

### 3. Multi-Cloud Strategy
Same 11-section form, different provider ribbon selection. Duplicate a vine from AWS to GCP. The form auto-translates service names and configurations.

### 4. Platform Engineering Foundation
Build your IDP on top of Trellis. The vine schema, job queue, and worker system are the infrastructure layer. Add your own application deployment logic on top.

---

## Positioning Statement

**For** platform engineers and DevOps teams
**who** need to provision and manage multi-cloud Kubernetes infrastructure,
**Trellis** is an open-source infrastructure configuration platform
**that** lets you design infrastructure visually and deploy from the terminal with zero static credentials.
**Unlike** Terraform Cloud, Spacelift, and Env0,
**Trellis** combines a guided visual form with an interactive CLI, generates cloud-native Terraform (not abstractions), and never stores your cloud keys.
