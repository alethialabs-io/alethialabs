# 15 — MVP Scope & Milestones

> **Status:** the architecture is locked (see [06](06-self-hosting-architecture.md)/[07](07-auth-rbac-sso.md)/[08](08-integrations-extensibility.md)); milestone exit criteria below reflect the resolved design. Tighten as implementation starts.

## MVP scope statement

Alethia MVP = an **open-source, self-hostable, multi-cloud, zero-trust** Kubernetes infrastructure control plane. The MVP proves the four pillars from [01-product-vision](01-product-vision.md):

1. **Zero-trust remote provisioning** (already shipped — hardened, not built).
2. **Self-hostable** — runs without Supabase or any single SaaS ([06](06-self-hosting-architecture.md)).
3. **Pluggable integrations** — at least one real provider per category from the existing catalog ([08](08-integrations-extensibility.md)).
4. **Multi-cloud breadth** — more than the current 3 clouds, user's choice ([09](09-multi-cloud-cluster-strategies.md)).

Plus the foundation: rename, OpenTofu, AGPL/LICENSE.

## Non-goals (explicit)

- **Not** a managed-Kubernetes provider — you own your clusters in your accounts.
- **Not** a CI/CD platform — Alethia provisions infrastructure, not app pipelines.
- **Not** single-cloud, and **not** Hetzner/Talos-only — Talos is one optional cluster strategy, not the headline.
- **Not** a hosted-only product — self-hostability is a launch requirement, not a later add-on.

## Product releases: V1 → V2

The technical milestones below ladder up to two product releases:

- **V1 — "Provision & Own"** (launch). The complete, GitOps-wired cluster you own (already provisions + wires ArgoCD to your repo today), made **self-hostable + multi-tenant-ready + open-core** via the MVP work — plus a thin day-2 **visibility** layer (sync/cost/health) and the integration breadth. The wedge: be the *anti-Porter*. Spans **M0–M4** (rename + OpenTofu + de-Supabase + auth/RBAC + integrations + more clouds).
- **V2 — "Provision & Operate."** An Alethia-native day-2/app experience — deploys, logs, rollbacks, preview envs, ongoing cluster management — rivaling Porter/Qovery's DX while staying self-hostable + zero-trust. Net-new surface beyond the MVP. (AI repo-scanner/MCP — **M5** — can land in V1.5 or V2.)

## Milestone waves (dependency-ordered)

Each milestone: 1-line goal + concrete exit criteria. Cross-references the owning doc.

### M0 — Foundation
**Goal:** clean names, open license, modern IaC engine.
- [ ] Rename landed across modules/DB/TS ([A-rename-lexicon](A-rename-lexicon.md)).
- [ ] Root `LICENSE` (AGPL-3.0) + SPDX headers + license-scan CI ([12](12-licensing-open-core.md)).
- [ ] OpenTofu swap validated by the no-spurious-diff test ([10](10-opentofu-migration.md)).

### M1 — Self-hosting / de-Supabase  *(long pole)*
**Goal:** the control plane runs on commodity infra (Postgres + S3-compatible + an identity layer), no Supabase.
- [ ] DB authz strategy implemented (RLS-via-JWT or app-layer) for the 16 `auth.uid()` policies.
- [ ] Realtime replacement shipped (decision in [06](06-self-hosting-architecture.md)).
- [ ] Storage/TF-state on any S3-compatible store (MinIO verified).
- [ ] Docker-Compose single-tenant install boots end-to-end.

### M2 — Enterprise auth  *(long pole)*
**Goal:** SSO/RBAC/orgs; the paid open-core boundary.
- [ ] Identity layer chosen (build-vs-adopt, [07](07-auth-rbac-sso.md)) and integrated.
- [ ] OIDC/SAML SSO; RBAC model; git-provider OAuth survives de-Supabase.
- [ ] Orgs/multi-tenancy data model.

### M3 — Integrations catalog
**Goal:** per-category provider backends behind the existing card UI.
- [ ] Category interface defined (dns / observability / secrets / registry) ([08](08-integrations-extensibility.md)).
- [ ] ≥1 real backend per category live (e.g. Cloudflare DNS, Grafana/Prometheus, Vault, Docker Hub); `integrations` table stays the registry of record.

### M4 — Multi-cloud breadth
**Goal:** more providers + the two-axis cluster model.
- [ ] New provider(s) plugged into the single source of truth (`cloud/provider.go` + `registry.ts`) ([09](09-multi-cloud-cluster-strategies.md)).
- [ ] `ClusterStrategy` split: managed (EKS/GKE/AKS) vs self-managed (Talos/k3s, optional).

### M5 — AI scanner + MCP  *(scope TBC)*
**Goal:** repo→Spec scanner + one MCP tool layer for Claude + dashboard ([11](11-ai-scanner-mcp.md)).
- [ ] **Confirm at Wave-2 review whether M5 is in the MVP or deferred.**

## Timeline caveat (honest)

This is a **broad** MVP. **M1 (de-Supabase) and M2 (identity) are the long poles** — both are large refactors (the architecture is settled in 06/07, so the risk is execution, not design). M3/M4 can partially parallelize once the de-Supabase boundary is stable. Sequencing M0 first de-risks everything downstream (clean engine + license before heavy refactors).

## Risk register

| Risk | Likelihood / Impact | Mitigation |
|---|---|---|
| De-Supabase migration drags (4 subsystems) | High / High | Worker boundary already HTTP — scope to web tier + storage; tackle subsystems independently ([06](06-self-hosting-architecture.md)). |
| Identity build-vs-buy wrong call | Med / High | Decision doc with options + reversible adapter seam ([07](07-auth-rbac-sso.md)). |
| Integration breadth scope-creep | High / Med | Ship one backend per category; catalog stays data-driven; rest stay `coming_soon`. |
| Single-vendor / single-distro concentration | Med / Med | Multi-cloud + multi-strategy by design; no Hetzner/Talos lock-in. |
| Rename blast radius (modules/DB/TS) | Med / Med | Atomic PRs per high-churn area; checklist in [A-rename](A-rename-lexicon.md). |
| AGPL enterprise-adoption friction | Med / Med | "Tool-not-library" boundary + commercial license ([12](12-licensing-open-core.md)). |

## Decisions — resolved vs open

**Resolved** (architecture deep dive, 2026-06-15):
- **Identity** → Better Auth + the PDP/RBAC design ([07](07-auth-rbac-sso.md)).
- **Realtime** → SSE + Postgres LISTEN/NOTIFY, no Redis ([06](06-self-hosting-architecture.md)).
- **Open-core** → AGPL core + commercial `ee/` ([12](12-licensing-open-core.md)).

**Still open:**
- **AI/MCP scope** — keep in the MVP or defer to the first post-MVP milestone ([11](11-ai-scanner-mcp.md)).
