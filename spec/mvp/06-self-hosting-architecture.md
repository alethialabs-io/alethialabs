# 06 — Self-Hosting Architecture (De-Supabase)

**Status:** Accepted (architecture). **This is the most important doc in the set** — self-hostability is the product's north star and the open-core foundation.

## Why

Alethia must run on commodity infrastructure that anyone can self-host, with no dependency on a single SaaS. Today the control plane is welded to **Supabase** for four things — **Auth, RLS, Realtime, Storage** — and self-hosting Supabase itself is the opposite of "small package" (~10 containers: GoTrue, PostgREST, Realtime, Storage API, Kong, Studio, Deno edge, …). The goal is a control plane that runs as **~4 containers** on plain Postgres + an S3 bucket.

## The principle that makes this tractable

**The runner boundary is plain HTTP + S3 + Postgres RPCs — it never talks to Supabase directly** (`packages/core/api/api.go`, Bearer over `ALETHIA_WEB_ORIGIN`; `cloud/supabase_backend.go` speaks the raw S3 protocol). So self-hosting only has to unwind the **web tier + storage**; the entire provisioning engine is untouched. The four Supabase subsystems are addressed **independently**.

## Target stack — the "small package"

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
        app instances LISTEN→SSE    node (Go runner): TF state + artifacts
```

**4 required containers:** `app` · `postgres` · `s3` · `runner`. `redis` is an optional scale-out profile only. The operator provides one Postgres URL, one S3 endpoint + keys, and OAuth client secrets — nothing else.

## The four subsystems

### 1. Database + authorization (replaces RLS)

- **Today:** ~64 RLS policies, all pure per-user ownership (`auth.uid() = user_id`, or `vine_id IN (SELECT id FROM specs WHERE user_id = auth.uid())`). No org/membership tables. Server actions trust RLS implicitly (e.g. `app/server/actions/zones.ts` has *no* explicit filter).
- **Target:** Postgres stays (it's portable). Data access moves to **Drizzle (Apache-2.0)**; the `supabase gen types → merge-for-supazod → supazod` pipeline is replaced by Drizzle schema + in-core `createSelectSchema`. Authorization moves behind a single **Policy Decision Point** and is enforced in the app — with **coarse Postgres RLS (`org_id`) kept as an unbypassable backstop**. Full design in **[07-auth-rbac-sso](07-auth-rbac-sso.md)**.
- **Critical sequencing:** removing `auth.uid()` RLS without a replacement is a **security regression**. The coarse-RLS backstop (`org_id = current_setting('app.current_org')`, set per-request via transaction-scoped `set_config`) must land **in the same PR family** that removes the Supabase policies — never a window without a backstop.
- **Exit criterion:** zero `supabase.from()` / `auth.uid()` in the codebase; every read/write goes through Drizzle + the PDP; cross-tenant isolation test passes.

### 2. Auth (replaces Supabase Auth / GoTrue)

- **Today:** Supabase Auth — 4 social providers (GitHub/Google/GitLab/Bitbucket) + magic link, ~46 `supabase.auth.*` call sites, middleware route-protection. The **CLI device-code flow is already decoupled** (custom HS256 JWT + `cli_logins`). `provider_tokens` table manually stores git OAuth tokens because Supabase doesn't persist them.
- **Target: Better Auth (MIT, in-process)** with the Drizzle adapter. Social: GitHub/Google native, GitLab/Bitbucket via `genericOAuth`; magic link via plugin. Session middleware replaces `lib/supabase/middleware.ts`.
  - **`provider_tokens` becomes redundant:** Better Auth's `account` table natively stores per-provider `accessToken`/`refreshToken`/expiry. Migration crux = repoint `getProviderToken()` (`app/server/actions/identities.ts`) to read `account`. Ensure login OAuth scopes include the repo scopes the integrations need.
  - **CLI:** keep the custom device-code JWT for phase 1 (repoint its two `cli_logins`/`profiles` reads to Drizzle; HS256 signing unchanged) → **zero CLI-binary changes**. Later, optionally adopt Better Auth's RFC-8628 `deviceAuthorization` plugin (unifies CLI identity with org/SSO) as a deliberate, versioned CLI release.
  - `verifyRunnerToken` / `verifyCliToken` stay as stable seams.
- **Exit criterion:** web login/session on Better Auth; users + git tokens migrated to `user`/`account`; CLI + runner auth unchanged and green.

### 3. Realtime (replaces Supabase Realtime / `postgres_changes`)

- **Today:** `postgres_changes` for live **job-log streaming** (the critical feature: runner `POST` → `insert_job_log()` RPC → `job_logs` → frontend INSERT subscription on `dashboard/jobs/[id]/page.tsx`), plus `provision_jobs`/`specs` status. The job page *also* polls status every 3 s. The `runners` and `cloud_identities` subscriptions are already **broken** (not in the publication) → effectively poll-only today; do **not** preserve them.
- **Target: SSE backed by Postgres LISTEN/NOTIFY.** Add `pg_notify('job_logs', {jobId, logId})` (IDs only — 8 KB cap) inside `insert_job_log` (or an `AFTER INSERT` trigger). Each app instance holds **one** LISTEN connection and fans out to its SSE clients → **multi-instance with NO Redis**. Browser uses `EventSource('/api/stream/jobs/:id')`; on (re)connect it fetches logs since its last `logId`. The **3 s poll stays** as the reconciliation backstop (no message-loss regression). Heartbeat comment every ~20 s; document HTTP/2 at the proxy (SSE's ~6-conn/host HTTP/1.1 cap).
- **Scale-out:** a Redis pub/sub implementation sits behind a **`RealtimeTransport`** interface for very-high-fan-out / hosted deployments. Default profile never starts Redis.
- **Exit criterion:** live logs + status stream over SSE across ≥2 app instances with no Redis; `supabase_realtime` publication dropped.

### 4. Storage (replaces Supabase Storage)

- **Today:** 2 buckets — `plan-artifacts` (TF plan binaries, via one API route using `supabase.storage.from()` + service role) and `spec-terraform-state` (TF state; runner via S3 protocol through `supabase_backend.go`, `SUPABASE_S3_*`). Runner is already S3-native (`use_path_style`, custom endpoint, `use_lockfile=true` → no DynamoDB).
- **Target: any S3-compatible store; default-bundle SeaweedFS (Apache-2.0).** MinIO is now **AGPLv3 and archived/maintenance-mode (Feb 2026)** — avoid as the default; keep the endpoint swappable (SeaweedFS / Garage / MinIO / AWS S3 / R2). Runner = **env/endpoint change only** (rename `SUPABASE_S3_*` → `ALETHIA_STORAGE_*` — the `ALETHIA_*` env convention, backend-agnostic noun, per [A-rename-lexicon](A-rename-lexicon.md)). The one web route (`app/api/jobs/[id]/plan-artifact/route.ts`) swaps `supabase.storage` → `@aws-sdk/client-s3` (~40 lines). Behind a thin `StorageBackend` wrapper so "which S3" is pure config (also lets the hosted tier point at AWS S3/R2).
- **State migration:** `aws s3 sync` the `spec-terraform-state` bucket before cutover — TF state is the only un-regenerable data; plan artifacts are ephemeral.
- **Exit criterion:** plan upload/download + TF state read/write work against SeaweedFS; no `supabase.storage` references remain.

## Job queue — stays as-is (no pg-boss for provisioning)

The provisioning queue is already robust: `claim_next_job` uses two-pass **`FOR UPDATE SKIP LOCKED`** (assigned runner → unassigned by `cloud_identity` affinity), with heartbeat + `recover_stale_jobs()` crash recovery. **Keep these RPCs verbatim**, called from Drizzle via raw SQL (`db.execute(sql\`select * from claim_next_job(...)\`)`). The Go runner still pulls over HTTP — pg-boss (a runner consumer model) doesn't serve it. The 1-minute `recover_stale_jobs` cron moves **off the AWS Lambda** into an in-app interval (or pg-boss later) so the self-host story has no Lambda dependency. **pg-boss is deferred** to whenever the first *Next-side* background job appears (transactional emails, log/artifact cleanup, scheduled scale-down) — there are zero today.

## Phased migration (de-risked; rollback per phase)

| Phase | Work | Why here | Risk |
|---|---|---|---|
| **P0** | De-Supabase **backstop**: add `org_id` + coarse RLS + `set_config` wrapper, **alongside** removing `auth.uid()` | never a window without isolation | M |
| **P1** | Data → Drizzle (53 `.from()` files, highest-traffic first) + storage swap (independent, low-risk) | mechanical; dual-mode possible per file | M / L |
| **P2** | PDP interface + community RBAC + Better Auth orgs/SSO; refactor all call sites; CI guard | see [07](07-auth-rbac-sso.md) | M |
| **P3** | **Auth cutover** to Better Auth (hard switch for web; CLI/runner untouched); migrate `auth.users`→`user`, `provider_tokens`→`account` | highest risk → after data/storage are stable | H |
| **P4** | Realtime → SSE (LISTEN/NOTIFY); drop `supabase_realtime` | poll backstop already present | M |
| **P5** | Cleanup: remove `@supabase/*`, `merge-for-supazod.mjs`, `supabase/` dir, `update-types`/`update-schemas`; retire the Lambda | — | L |

Take a full DB snapshot before **P3** (the commitment point) and keep the Supabase project warm until Better Auth is validated in prod.

## The self-host deliverable

A `docker-compose.yml` with `app`, `postgres`, `s3` (SeaweedFS), `runner`, and an optional `redis` profile — plus a `.env.example` (Postgres URL, S3 endpoint+keys, OAuth secrets) and a one-command bootstrap (`drizzle-kit migrate` + seed). Single-tenant by default; the org/multi-tenant layer is the commercial `ee/` ([12-licensing-open-core](12-licensing-open-core.md)).

## Notes

- **License posture:** the whole bundled stack is permissive — Better Auth (MIT), Drizzle (Apache-2.0), SeaweedFS (Apache-2.0), Postgres (PostgreSQL license). No AGPL dependency is forced on self-hosters; AGPL is *our* code only ([12](12-licensing-open-core.md)).
- This doc is the **contract**: every future subsystem decision is judged by "does it run without Supabase / any single SaaS?"
