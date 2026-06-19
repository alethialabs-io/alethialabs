# 05 — Architecture Overview

System topology, the control/execution split, the two-axis provider model, and the data model — in the Alethia lexicon. Deep dives: self-hosting [06](06-self-hosting-architecture.md), authz [07](07-auth-rbac-sso.md), providers [09](09-multi-cloud-cluster-strategies.md), repo structure & naming [18](18-repo-structure-and-naming.md).

## Topology

```
 Browser ─┐                         ┌─ Postgres (app + auth + queue RPCs + LISTEN/NOTIFY)
 alethia CLI ─┼─► Alethia web (Next.js) ─┼─ S3 (SeaweedFS / any S3)
          │   Better Auth · Drizzle  │
          │   PDP · SSE              └─ ── ── ── ── ──┐
          │                                           │ HTTP (Bearer) + S3 + Postgres
          └─────────────────────────────────────►  runner (Go runner)
                                                       │ assumes role at runtime
                                                       ▼
                                              Your cloud account (provision)
```

Self-host footprint ≈ **4 containers** (web · postgres · s3 · node). See [06](06-self-hosting-architecture.md).

## Control plane vs execution plane (the zero-trust split)

- **Control plane** (Alethia web + Postgres): designs Specs, queues jobs, stores config and *identifiers* — never cloud secrets.
- **Execution plane** (runner runner): runs in/against the user's cloud, **assumes roles at execution time**, executes OpenTofu, streams logs back over plain HTTP. The control plane and runner share only an HTTP/S3/Postgres contract (`packages/alethia-core/api/api.go`) — which is why the runner is unaffected by the de-Supabase migration.

## The two-axis provider model

Provisioning is parameterized on two independent axes (detail in [09](09-multi-cloud-cluster-strategies.md)):

| Axis | Today | Target |
|---|---|---|
| **CloudProvider** (infra) | `aws` / `gcp` / `azure` (hardcoded in `cloud/provider.go` + `registry.ts`) | many providers behind one source of truth |
| **ClusterStrategy** | managed only (EKS/GKE/AKS) | `managed` \| `self-managed` (Talos/k3s, optional) |

One level down, **category providers** (DNS/secrets/registry/observability) are pluggable per Spec ([08](08-integrations-extensibility.md)).

## Data model

```
user ──(member of)──► org [ee]           # community: org=null, single-owner
   └──owns──► Zone ──contains──► Spec ──has──► components
                                          (cluster, network, dns, databases, caches,
                                           queues, topics, nosql, registries, secrets, observability)
Spec ──provision──► job ──claimed by──► runner (runner)
authz: every access via the PDP; coarse org_id RLS backstop  (see 07)
integrations: catalog (registry of record) + credentials (cloud_identities / provider_tokens / integration_credentials)
```

- **Specs** carry per-component config; each component has a `provider_config` JSONB and (target) a `provider` selector.
- **Jobs** are rows claimed atomically (`FOR UPDATE SKIP LOCKED`); the **runner** streams logs and finalizes outputs.
- **Authorization** runs through the PDP with a coarse `org_id` RLS blast-wall ([07](07-auth-rbac-sso.md)).

## Tech stack (target)

- **Web:** Next.js 16, React 19, Better Auth (MIT), Drizzle (Apache-2.0), Tailwind/shadcn, SSE.
- **Data/infra:** Postgres, S3 (SeaweedFS default), OpenTofu, ArgoCD.
- **Go:** `alethia` (CLI), `runner` (runner), `alethia-core` (shared lib: cloud abstraction, IaC exec, API client).
- **Monorepo:** pnpm + Turborepo + Go workspaces; release-please + GoReleaser. Commercial `ee/` workspace ([12](12-licensing-open-core.md)).

## Job lifecycle

`design Spec → queue job → runner claims (SKIP LOCKED) → assume role → OpenTofu init/plan/apply → stream logs (SSE) → finalize outputs (cluster endpoint, etc.) → ArgoCD reconciles`. Stale jobs are recovered by a periodic `recover_stale_jobs` sweep (moving off the AWS Lambda for self-host, see [06](06-self-hosting-architecture.md)).
