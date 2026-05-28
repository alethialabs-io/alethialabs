# Architecture Design Document: Viticulture Themed Infrastructure System

**Version:** 3.0
**Status:** Active
**Context:** Monorepo (Trellis, Grape, Vintner, Terraform, ArgoCD)

## 1. Executive Summary

The system provides a Trellis control plane, a Grape CLI, and an ArgoCD-based GitOps runtime for managing infrastructure in user-owned cloud accounts.

The active architecture no longer depends on Tendril as an in-cluster polling agent. Tendril remains historical context from the previous design and should be removed from active product documentation once migration work is complete.

## 2. Core Concepts

| Term | Meaning |
| --- | --- |
| Trellis | The Next.js web control plane and Supabase-backed state store. |
| Grape | The Go CLI used for authentication, Vine pulls, local orchestration, bootstrap, deployment, and teardown. |
| Vintner | The documentation application. |
| Vineyard | A logical workspace for infrastructure, usually tied to a cloud account/team/environment boundary. |
| Vine | A declarative infrastructure configuration. |
| Harvest | A provisioning or sync run. In the target GitOps architecture, this should represent an auditable materialization/sync event, not a Tendril agent queue. |
| ArgoCD | The in-cluster GitOps reconciler installed during bootstrap. |
| Tendril | Deprecated remote-agent design. Kept only as archived context until code/docs are removed. |

## 3. High-Level Topology

### 3.1 Trellis Control Plane

Trellis owns:

- user authentication,
- Vineyards and Vines,
- cloud identities,
- Git provider tokens,
- run and log records,
- UI status and observability.

Trellis does not run long-lived Terraform jobs inside request handlers.

### 3.2 Grape Local Orchestrator

Grape owns:

- local CLI auth,
- pulling Vines from Trellis,
- reading legacy YAML files,
- resolving AWS credentials through cloud identities or local profiles,
- running Terraform, Helm, kubectl, Git, AWS CLI, and Infracost,
- streaming logs back to Trellis when authenticated.

### 3.3 GitOps Runtime

ArgoCD runs inside the bootstrapped cluster and reconciles GitOps repositories that Trellis and/or Grape prepare. The Git repository becomes the cluster-facing source of truth for deployable Kubernetes and Helm configuration.

## 4. Workflow

### Step 1: Authenticate

The user logs in through Trellis or runs `grape login` for CLI access.

### Step 2: Connect Cloud And Git Identities

The user connects AWS through a cross-account role with an External ID, or explicitly uses a local AWS profile for operator-driven workflows.

The user links GitHub, GitLab, or Bitbucket so Trellis can discover repositories and commit GitOps changes.

### Step 3: Plant Or Pull A Vine

The user creates a Vine in Trellis or pulls a Vine locally with Grape. During migration, Grape must also support legacy YAML files from `apps/legacy-cli`.

### Step 4: Bootstrap A Vineyard

The user runs `grape bootstrap`.

Grape provisions the base AWS/EKS infrastructure locally, installs ArgoCD, wires ArgoCD to the Vineyard GitOps repository, and streams bootstrap logs to Trellis.

### Step 5: Materialize And Sync

Trellis serializes Vine changes into the GitOps repository. ArgoCD syncs those changes into the cluster.

The CLI may keep a `harvest` command or alias, but the command should trigger GitOps materialization/audit behavior rather than a Tendril polling queue.

### Step 6: Teardown

The user runs `grape teardown` to disable ArgoCD self-healing, delete Kubernetes ingress resources, run Terraform destroy, and optionally clean generated repository paths.

## 5. Security Architecture

- Trellis stores no static AWS access keys.
- AWS onboarding uses an External ID and cross-account IAM Role ARN stored in `cloud_identities`.
- Grape can assume the connected role or use an explicit local AWS profile.
- Git provider access tokens are stored in Trellis `provider_tokens` and used server-side for repository discovery and GitOps commits.
- ArgoCD pulls from Git and does not require inbound access to the user cluster.
- Long-running cloud mutations happen in Grape or the cluster reconciler, not in Trellis HTTP handlers.

## 6. Migration Notes

The canonical migration plan lives in [spec/features/grape-legacy-migration](./features/grape-legacy-migration/README.md).

Known architecture cleanup still required:

- remove Tendril language from Grape help and Vintner active docs,
- remove or archive `apps/tendril`, `packages/charts/tendril`, and Grape embedded Tendril assets,
- implement missing Trellis bootstrap-job API routes,
- wire ArgoCD app-of-app configuration during bootstrap,
- define the final Harvest/GitOps sync semantics.
