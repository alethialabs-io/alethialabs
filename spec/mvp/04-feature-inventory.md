# 04 — Feature Inventory

Honest **SHIPPED vs TO-BUILD**, re-grounded on the real code (the old inventory was stale — it referenced `deploy`/`bootstrap`/`config` commands that no longer exist).

## ✅ Shipped (verified in code)

**Zero-trust remote provisioning**
- Runner assumes cloud roles at execution time — no static keys stored. AWS cross-account IAM (`AssumeRole`), GCP WIF and Azure federated identity wired in `packages/core/cloud/*` + the runner.
- Robust job broker: `claim_next_job` two-pass **`FOR UPDATE SKIP LOCKED`**, heartbeat, `recover_stale_jobs`, log streaming, scale-to-zero Fargate via the Lambda scaler.

**`alethia` CLI** (`apps/cli/cmd/`, distributed via Homebrew)
- `spec apply` / `spec plan`, `zone`, `jobs` (list/get/logs/cancel/wait), `runner` (runner lifecycle), `clusters`. Device-code auth (custom JWT). Charmbracelet TUI. *(No `deploy`/`bootstrap`/`config` — those are gone.)*

**Web control plane** (Next.js + Postgres)
- Visual **Spec** designer (multi-section form) with per-component infra tables; real-time **cost sidebar** (Infracost); live **job-log viewer**; runners dashboard; plan viewer; audit log.

**Multi-cloud schema + templates**
- Cloud-agnostic component tables (`vine_cluster`/`network`/`dns`/`databases`/`caches`/`queues`/`topics`/`nosql`/`container_registries`/`secrets`, each with a `provider_config` JSONB hook). OpenTofu/Terraform templates under `infra/templates/spec/{aws,gcp,azure}/`. **AWS is the active, verified path; GCP/Azure templates exist but provider onboarding is marked `coming_soon`** in the catalog.

**Integrations catalog** (data-driven, `integrations` table + card UI)
- Git: GitHub/GitLab/Bitbucket (active, OAuth). Cloud: AWS (active), GCP/Azure (coming_soon). Six category providers seeded `coming_soon`: Cloudflare (dns), Vault (secrets), Datadog/Grafana/Prometheus (observability), Docker Hub (registry).

**GitOps app-delivery (wired, not just installed)**
- ArgoCD installed **and connected to the user's Git repo** (`AppsDestinationRepo`) with auto-sync (prune + self-heal) → user apps deploy from a `git push`. Full operator suite via app-of-apps: external-secrets, external-dns, AWS load-balancer-controller, Karpenter, metrics-server, gp3 storage class.

## 🟡 In progress / partial
- GCP/Azure parity (templates exist; onboarding `coming_soon`).
- runner maturity (instant scale-up is recent).

## 🔨 To build — MVP (this spec set)
| Area | Doc |
|---|---|
| Self-hosted stack: Better Auth + Drizzle + Postgres + SeaweedFS + SSE; RLS backstop | [06](06-self-hosting-architecture.md) |
| Auth/RBAC/SSO: PDP + community RBAC → OpenFGA, orgs | [07](07-auth-rbac-sso.md) |
| Integration backends: the 6 `coming_soon` providers + `integration_credentials` + `vine_observability` | [08](08-integrations-extensibility.md) |
| Terraform → OpenTofu | [10](10-opentofu-migration.md) |
| More clouds + managed/self-managed (Talos/k3s) cluster strategies | [09](09-multi-cloud-cluster-strategies.md) |
| Open-core `ee/` boundary + license hygiene | [12](12-licensing-open-core.md) |
| Rename to the Alethia lexicon | [A-rename-lexicon](A-rename-lexicon.md) |

## 🛣️ Roadmap (post-MVP)
- **AI repo-scanner + MCP** (repo → Spec; one tool layer for Claude + dashboard) — **scope TBC** ([11](11-ai-scanner-mcp.md)).
- Enterprise SSO/SAML/SCIM + audit export + multi-tenancy (the `ee/` tier).
- **Billing & monetization** — Stripe subscriptions (org = billing entity) + usage metering (runner-minutes, AI scans) + signed self-managed license key; drives entitlements ([14](14-gtm-pricing.md), [07](07-auth-rbac-sso.md)).
- **FinOps / cost-governance module** — spend per spec/team, chargeback/showback, drift-to-cost, right-sizing recommendations (builds on the existing Infracost + cloud-resource data). A differentiated paid add-on and a key revenue stream ([14](14-gtm-pricing.md)).
- **Compliance / zero-trust package** — SOC2-aligned audit + a "the control plane never stores your cloud keys" attestation/report for regulated buyers (`ee/` enterprise). Unique whitespace from the zero-credential model.
- pg-boss-backed Next-side background jobs (emails/cleanup/scheduled scale-down).

## 🗑️ Deprecated
- `apps/legacy-cli` (Python) — superseded by `alethia`; resolve its GPL-3.0 LICENSE ([12](12-licensing-open-core.md)).
- Runner-as-in-cluster-agent — replaced by the remote **runner** pull model.

---
*Freshness rule: when a feature ships or changes status, update this doc first, then propagate to landing/pitch/code ([00-README](00-README.md)).*
