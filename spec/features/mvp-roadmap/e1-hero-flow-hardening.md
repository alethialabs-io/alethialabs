# E1 — Hero flow: AWS E2E hardening + proof

**Goal:** the AWS hero flow is **provably** end-to-end — connect identity → design Spec → plan (+ live
cost) → apply → real EKS + ArgoCD **wired to a git repo (push→deploy)** + outputs in the dashboard →
`destroy`. Today it's ~95% wired but **unvalidated post-migration** and the GitOps bootstrap fails
silently. Community/core.

## Problem (grounded in code)
In `packages/core/provisioner/deploy.go` (the `installArgoCD` + GitOps block, ~L263-289) every step
degrades to a `Warning:` on stderr while the job still returns success:
- `installArgoCD(...)` error → warning only.
- `ConfigureRepoCredentials` runs **only if** `AppsDestinationRepo != "" && GitAccessToken != ""` —
  if the user set an apps repo but the token is missing/empty, it's **skipped silently** → ArgoCD
  installed but **not** connected → "push→deploy" never works, job still SUCCESS.
- `resolveArgoTemplatesDir()` == "" → prints "skipping infra-services" and moves on (silent) — in the
  runner image the templates must be baked at `/home/runner/argocd-templates`.
- render / `kubectl apply` failures → warnings only.

Net: a user can get a cluster with **no working GitOps and no error**. That breaks the core promise
("GitOps, wired — not just installed").

## Tasks
- [ ] **Make GitOps failures loud when GitOps was requested.** When `AppsDestinationRepo != ""`, a
      missing/empty `GitAccessToken`, missing `argocd-templates`, or a failed repo-cred/apply step must
      **fail the job** with a clear, actionable message (not a buried warning). When no apps repo is
      configured, infra-services still install; their failure is surfaced prominently (decide: fail vs
      degraded-status) — at minimum a distinct error log + a job `execution_metadata.gitops_status`.
- [ ] **Guarantee the templates ship.** Verify `infra/templates/argocd` is copied into the runner
      image at `/home/runner/argocd-templates` (the `release-runner`/`deploy-fleet-aws` workflows do
      `cp -r infra/templates/argocd …`; assert the Dockerfile bakes them) and add a build-time check.
- [ ] **Connector pre-flight verification.** Validate Cloudflare/Vault/etc. credentials at connect
      time (or job-claim time), not 15 min into `apply` — `packages/core/categories/compose.go` has no
      connectivity check today; add a `Verify()` per `CategoryProvider` (or a console-side check on save).
- [ ] **Surface `gitops_status` to the dashboard** (cluster card shows wired/degraded/failed).
- [ ] **The proof run** (needs a real AWS account + `docker compose up`): connect → design → plan (cost
      shows) → apply → assert real EKS reachable (kubeconfig), ArgoCD reachable + repo connected, a test
      `git push` reconciles, outputs in dashboard → `destroy` cleans up. Record it in `06-e2e-test-plan`.

## Touch points
`packages/core/provisioner/deploy.go` · `packages/core/argocd/{install,render,infra_facts}.go` ·
`apps/runner/internal/agent/runner.go` (template resolution, job status/metadata) ·
`packages/core/categories/compose.go` (pre-flight) · `apps/runner/Dockerfile` (template baking) ·
console cluster card (`gitops_status`).

## Done when
The proof run is green and repeatable; GitOps failure can no longer masquerade as success; connector
creds fail fast at connect time.
