# 06 — Self-Hosting Architecture

**Status:** Implemented. **This is the most important doc in the set** — self-hostability is the product's north star and the open-core foundation.

## Why

Alethia runs on commodity infrastructure that anyone can self-host, with no dependency on a single SaaS. The control plane needs only **four things** — **a database, auth, realtime, and object storage** — and each is satisfied by a permissive, self-hostable component. The control plane runs as **~4 containers** on plain Postgres + an S3 bucket.

## The principle that makes this tractable

**The runner boundary is plain HTTP + S3 + Postgres RPCs — the runner never talks to the web tier's internals** (`packages/core/api/api.go`, Bearer over `ALETHIA_WEB_ORIGIN`; `cloud/s3_backend.go` speaks the raw S3 protocol). So the entire provisioning engine is decoupled from the web tier + storage, and the four subsystems below are independent.

## The stack — the "small package"

```
        ┌──────────────────────────────────────────────┐
Browser ┤  app  (Next.js: Better Auth + Drizzle + SSE)  │
  CLI ──┤   /api/auth/*  /api/cli/*  /api/jobs/*         │
 runner ──┤   /api/stream/*  (SSE)                          │
        └───────┬───────────────────────┬────────────────┘
                │                        │
        ┌───────▼────────┐      ┌────────▼─────────┐
        │   postgres     │      │   s3 endpoint    │
        │ app + auth +   │      │  SeaweedFS       │
        │ queue RPCs +   │      │  (Apache-2.0,    │
        │ LISTEN/NOTIFY  │      │  swappable)      │
        └───────┬────────┘      └────────┬─────────┘
                │ NOTIFY (ids only)       │ S3 protocol
                ▼                         ▼
        app instances LISTEN→SSE    runner (Go): TF state + artifacts
```

**4 required containers:** `app` · `postgres` · `s3` · `runner`. `redis` is an optional scale-out profile only. The operator provides one Postgres URL, one S3 endpoint + keys, and OAuth client secrets — nothing else.

## The four subsystems

### 1. Database + authorization

- **Postgres + Drizzle (Apache-2.0).** The schema lives in `lib/db/schema/*.ts`; column types are inferred from the schema (`$inferSelect`/`$inferInsert`) and validators come from `drizzle-zod` — no generated types pipeline.
- **Authorization is a single Policy Decision Point** enforced in the app, with **coarse Postgres RLS (`org_id`) as an unbypassable backstop** (`org_id = current_setting('app.current_org')`, set per-request via transaction-scoped `set_config`). Full design in **[07-auth-rbac-sso](07-auth-rbac-sso.md)**.

### 2. Auth — Better Auth

- **Better Auth (MIT, in-process)** with the Drizzle adapter. Social: GitHub/Google native, GitLab/Bitbucket via `genericOAuth`; magic link via plugin. Session middleware gates the dashboard routes.
- **Provider tokens** live on Better Auth's `account` table (per-provider `accessToken`/`refreshToken`/expiry); login OAuth scopes include the repo scopes the integrations need.
- **CLI** uses a custom device-code JWT (HS256 + `cli_logins`), decoupled from the web session. `verifyRunnerToken` / `verifyCliToken` are the stable auth seams for the runner + CLI APIs.

### 3. Realtime — SSE backed by Postgres LISTEN/NOTIFY

- Live **job-log streaming**: the runner `POST`s logs → `insert_job_log()` RPC → `job_logs`, which `pg_notify('job_logs', {jobId, logId})` (IDs only — 8 KB cap). Each app instance holds **one** LISTEN connection and fans out to its SSE clients → **multi-instance with NO Redis**. The browser uses `EventSource('/api/stream/jobs/:id')`; on (re)connect it fetches logs since its last `logId`. A short status poll remains as a reconciliation backstop (no message-loss regression).
- **Scale-out:** a Redis pub/sub implementation sits behind a **`RealtimeTransport`** interface for very-high-fan-out / hosted deployments. The default profile never starts Redis.

### 4. Storage — any S3-compatible store

- **Default-bundle SeaweedFS (Apache-2.0)**; the endpoint is swappable (SeaweedFS / Garage / AWS S3 / R2) via the `ALETHIA_STORAGE_*` env. Two buckets: `plan-artifacts` (TF plan binaries, via `app/api/jobs/[id]/plan-artifact/route.ts` using `@aws-sdk/client-s3`) and `spec-terraform-state` (TF state; runner via S3 protocol through `cloud/s3_backend.go`, `use_path_style`, `use_lockfile=true` → no DynamoDB). A thin `StorageBackend` wrapper keeps "which S3" pure config (the hosted tier points the same wrapper at AWS S3 / R2).

## Job queue

The provisioning queue is robust: `claim_next_job` uses two-pass **`FOR UPDATE SKIP LOCKED`** (assigned runner → unassigned by `cloud_identity` affinity), with heartbeat + `recover_stale_jobs()` crash recovery. These RPCs are called from Drizzle via raw SQL (`db.execute(sql\`select * from claim_next_job(...)\`)`). The Go runner pulls jobs over HTTP. `recover_stale_jobs` runs as an in-app interval (no external scheduler dependency). A general background-job system (pg-boss) is deferred until the first Next-side background job appears (transactional emails, log/artifact cleanup, scheduled scale-down).

## The self-host deliverable

A `docker-compose.yml` with `app`, `postgres`, `s3` (SeaweedFS), `runner`, and an optional `redis` profile — plus a `.env.example` (Postgres URL, S3 endpoint+keys, OAuth secrets) and a one-command bootstrap (`drizzle-kit migrate` + seed). Single-tenant by default; the org/multi-tenant layer is the commercial `ee/` ([12-licensing-open-core](12-licensing-open-core.md)).

## Notes

- **License posture:** the whole bundled stack is permissive — Better Auth (MIT), Drizzle (Apache-2.0), SeaweedFS (Apache-2.0), Postgres (PostgreSQL license). No AGPL dependency is forced on self-hosters; AGPL is *our* code only ([12](12-licensing-open-core.md)).
- This doc is the **contract**: every future subsystem decision is judged by "does it run without any single SaaS?"
