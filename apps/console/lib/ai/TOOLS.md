<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Alethia AI — Tool Catalog

The agent's capabilities map 1:1 onto existing **PDP-gated server actions** (`app/server/actions/*`).
**No new authority model** (`dataroom/spec/mvp/11-ai-scanner-mcp.md`): every tool calls an action that runs
`authorize(verb, {type, id?})` / `requireOwner()`, so the agent is bounded by the actor's grants. This
catalog is the source for `lib/ai/tools.ts` (the in-app agent) and, later, the MCP server (same defs).

Buckets: **READ** (safe data) · **PROPOSE** (HITL, client-applied, no write) · **MUTATE-VIA-JOB**
(queue a plan/deploy/destroy job — HITL + the M1 placement gate) · **DIRECT-WRITE** (DB write; expose
sparingly). Status: ✅ wired · ▢ candidate · ⛔ do-not-expose.

Tools live in `lib/ai/tools/` — `compose.ts` (canvas-building) + `read.ts` (read surface) + `index.ts`.

## READ — backing action · PDP verb (all ✅ wired, trimmed + secret-free)
- ✅ `list_services` — registry/`PROVIDERS` (pure) — addable node kinds + per-cloud service names.
- ✅ `list_service_options(provider)` — `lib/cloud-providers` tables — instance types / k8s / db / cache / regions.
- ✅ `estimate_cost` — `getRegionPrices` + `compute-cost-items` — monthly estimate of the canvas.
- ✅ `cidr_for_hosts(hosts)` — `lib/cloud-providers/cidr.ts` — smallest CIDR for N hosts (511→/23).
- ✅ `list_specs` — `getSpecs()` · `view spec`. ✅ `get_spec(id)` — `getSpec()` · `view spec` (components + sizes).
- ✅ `list_zones` — `getZones()` · `view zone` — workspaces + their specs.
- ✅ `list_jobs` / `get_job(id)` — `getJobs()` / `getJob()` · `view job`. ✅ `get_plan_result(id)` — `getPlanResult()`.
- ✅ `list_runners` — `getRunnersWithReleases()` · `view runner`.
- ✅ `list_clusters` — `getClusters()` — provisioned stacks (endpoints/dbs/caches). **`argocd_admin_password`
  dropped — never feed secrets to the model.**
- ✅ `list_cloud_identities` — `getVerifiedCloudIdentities()`. ✅ `list_connectors` — `getConnectorsWithStatus()`.
- ✅ `get_cached_resources(id)` — NEW `getCloudIdentityResources()` · `view cloud_identity` — existing VPCs/subnets.
- ▢ `billing_summary` / `usage_report` — `getBillingSummary()` / `getUsageReport()` — plan + metering (later).

## PROPOSE — HITL, client-applied (no server write)
- ✅ `propose_changes` — emits `AiProposal` → `applyProposal` (add_node / set_identity / update_config).
- ▢ `propose_spec` (Milestone B) — repo-scan → a right-sized `SpecConfig` proposal (no parallel schema).
- ▢ `compare_providers` (B) — provider cost/feature comparison via Infracost + `duplicateSpecForProvider`.

## MUTATE-VIA-JOB — HITL + M1 gate (DEFERRED — future: surface as accept-to-run confirm-actions)
- ▢ `plan_spec` — `planSpec(id)` · `plan spec` (`assertUsageAllowed`) — PLAN job.
- ▢ `provision_spec` — `provisionSpec(id, planJobId?)` · `deploy spec` (usage) — DEPLOY job; suggest
  plan→deploy chaining via `plan_job_id`.
- ▢ `rerun_job` — `rerunJob(id)` · `create job` (usage). `cancel_job` — `cancelJob(id)` · `edit job`.
- ▢ `refresh_cloud_resources` — `refreshCloudResources(id)` · `view cloud_identity` — FETCH_RESOURCES job.

## DIRECT-WRITE — expose sparingly (prefer PROPOSE→accept)
- ▢ `create_spec` — `createSpec()` · `create spec` — the agent should normally PROPOSE the canvas graph
  and let the user Save, not call this directly.
- ▢ `create_zone` / `update_zone` — `createZone` / `updateZone` · `create|edit zone`.

## ⛔ DO NOT EXPOSE (destructive / sensitive / out-of-scope)
- `deleteSpec` — immediate soft-delete, **does NOT deprovision cloud resources** (no DESTROY job exists).
- `deleteZone` — orphans specs. · Connector/cloud **credential writes** (`saveConnectorCredential`, etc.).
- Billing mutations (`openCheckout`/`openCustomerPortal`), org/member/team/role/grant/SSO changes
  (`assignGrant`, `createRole`, member ops) — admin/Enterprise surfaces, customer-driven only.

## Gaps to build (flagged by the DB inventory)
- **`destroySpec`** — no action queues a DESTROY job; needed before the agent (or UI) can safely tear down.
- **Component updates** — no `updateSpec*` actions; the agent can create/propose but not edit components
  post-create (today it edits via the canvas/form re-save path).
- Cloud-identity / runner updates — immutable; create-only.

## Rules
1. Every tool ⇒ an existing `authorize()`-gated action (no new authority).
2. Mutations are **HITL**: PROPOSE (canvas) or VIA-JOB (plan/deploy) — never silent writes.
3. Cross-cloud CORE placement stays gated (M1 `ValidatePlacement` / TS mirror).
4. Trim large reads before returning to the model (ids + summaries, not full rows).
