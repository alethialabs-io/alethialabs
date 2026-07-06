<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Alethia — pitch demo scenarios

The one product: **repos → a verified, GitOps Kubernetes cluster on your cloud** — with two
operator modes (managed = Alethia's runner fleet assumes role; self = your own runner), the "A"
flow (infer & generate) and the "B" flow (bring your own IaC + audit). Each scenario below maps to
the concrete engine capability that backs it, with a **status** so you pitch it truthfully.

Legend: **LIVE** = built + tested in this repo · **WIRING** = engine done, needs an integration
seam (git push / runner job / cron) · **CLOUD** = needs a real cluster run to show end-to-end.

---

## 1 — Hero: "From repo to a running, *proven* cluster"

_Connect an app repo → Alethia infers the stack → provisions EKS + RDS + the app → elench proves it._

- **Scan → infer → propose.** `pnpm` scanner (`packages/core/scanner`) statically reads the repo →
  `RepoDigest` (+ detected services); the console LLM infers backing needs → a guaranteed-valid
  proposed project. **LIVE** (unit-tested). The assistant on the project page drives it.
- **Provision cluster + ArgoCD.** `provisioner.RunDeployV2` → tofu apply → ArgoCD → apps. **CLOUD.**
- **Proof.** Between plan and apply, `packages/core/verify` runs keyless / least-privilege / OIDC
  controls and emits an **ed25519-signed receipt**; the assistant shows the `VerifyBlock` verdict
  before deploy. **LIVE** (engine tested; surfaced via `get_plan_result`).

> Pitch line: "It doesn't just build the cluster — it hands you a signed proof that it's keyless and
> least-privilege, and keeps proving it."

## 2 — Multi-cloud: "Same project, now on GCP (or Azure)"

_Flip the target cloud; the same design provisions with cloud-native workload identity._

- The provisioner is cloud-agnostic; the **GitOps seam** (`argocd.BuildFromOutputs` + templates) now
  renders per cloud — external-dns gets IRSA / **GKE Workload Identity** / **Azure Federated
  Identity** automatically. **LIVE** (render golden tests; GCP+Azure Terraform `tofu validate`-clean).
- Adding a *fourth* cloud is a documented 5-step checklist (`packages/core/cloud/README.md`).

> Pitch line: "Multi-cloud isn't a slide — the AWS-only assumption is gone; new clouds are a config
> change, not a rewrite." (Real GKE/AKS run = **CLOUD**.)

## 3 — Monorepo / multi-repo: "One project, many services"

_Point at a monorepo (or several repos); Alethia detects each service and merges them into one project._

- The scanner detects per-directory services (Dockerfile/workspace) → `RepoDigest.Services`; the
  console merges N repos / services into one project (`mergeScansToFormData`, de-duped), persisted as
  `project_source_repos` (1:N). **LIVE** (Go + TS unit tests; migration 0050). The canvas shows the
  `SourceReposCard` (repos + services).

## 4 — Audit (the "B" flow): "Bring your existing IaC — we grade it"

_Point at a customer's existing terraform plan or k8s manifests; elench flags the risks + proposes fixes._

- **Existing terraform:** `verify.ParseCustomerPlan` audits a plan Alethia *didn't* generate with the
  **same** controls (a static access key → `KEYLESS-001` fail; an admin policy → `LEASTPRIV-001`).
  **LIVE.**
- **k8s manifests:** `verify.EvaluateManifests` flags root/privileged/`:latest`, wildcard RBAC /
  anonymous bindings, host access, missing limits. **LIVE.** Try it now:

  ```bash
  printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: bad}\nspec:\n  template:\n    spec:\n      containers:\n      - {name: app, image: nginx:latest, securityContext: {privileged: true}}\n' \
    | go run ./packages/core/verify/cmd/elench-verify -manifests
  # → verdict: fail  (CONTAINERSECURITY-001: privileged + :latest); exits non-zero
  ```

- Nice kicker: the manifests **Alethia generates** (`packages/core/manifests`) pass this audit by
  construction (non-root, drop-ALL, RO-rootfs, limits). **LIVE.**
- Console "Audit existing infrastructure" UI + IMPORT job linking findings to the `cloud_*` inventory
  = **WIRING**.

## 5 — Day-2: "It keeps proving it"

_After provisioning, drift + posture stay visible; ask the assistant "what changed."_

- `packages/core/drift.Analyze` turns a `plan -refresh-only -json` into a deterministic `Posture`
  (honest about what refresh-only can't see). **LIVE** (tested). Stored per environment
  (`environment_drift`, migration 0051); read by the assistant + **external agents over MCP**
  (`get_drift_posture`, live `/api/mcp`, OAuth-gated). **LIVE** (data + read surface).
- The DETECT_DRIFT cron producer (runner runs refresh-only → `recordDriftPosture`) + a posture badge
  = **WIRING**.

---

## What to wire for a full live click-through (in priority order)

1. Deploy-time **manifest commit** to the GitOps repo (thread services → config snapshot →
   `manifests.WriteManifests` → git push) + a generate/BYO toggle.
2. **/api/verify** + "Audit existing infrastructure" UI + an IMPORT/AUDIT runner job (runs
   `elench-verify`) → `VerifyBlock`.
3. **DETECT_DRIFT** cron + runner handler → posture badge.
4. One real **GKE/AKS** end-to-end run (the seam + `tofu validate` are green; only a live cluster is
   unproven).

See the plan ledger (`~/.claude/plans/…`) for the exact next steps; the engines behind every scenario
are committed + tested on `staging`.
