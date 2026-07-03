# Alethia — Web Control Plane

The Next.js control plane for **Alethia Labs**: the dashboard for provisioning and
managing multi-cloud infrastructure, plus the API the `alethia` CLI and the runner
talk to. Part of the [monorepo](../../README.md) — see the root README for the full
architecture.

**Stack:** Next.js 16 · React 19 · TypeScript · PostgreSQL via Drizzle ORM · Better
Auth · Tailwind CSS 4 / shadcn/ui · S3-compatible object storage. Authorization is a
Policy Decision Point (PDP) with built-in roles + grants (open core); the licensed
`@alethia/ee` package adds orgs, SSO, teams, custom roles, and the OpenFGA engine.

## Local development

The repo ships a self-host stack (Postgres + SeaweedFS S3) so a fresh checkout runs
with zero manual setup. From the **repo root**:

```bash
cp .env.example .env          # dev defaults work out of the box
docker compose up -d          # Postgres + S3 (console auto-runs migrations on boot)
pnpm install
pnpm -F console dev           # http://localhost:3000
```

Configuration is read from the environment — see [`.env.example`](../../.env.example)
for every variable. The essentials: `ALETHIA_DATABASE_URL`, `BETTER_AUTH_SECRET`,
`NEXT_PUBLIC_APP_URL`, the `ALETHIA_STORAGE_*` S3 settings, `CLI_JWT_SECRET`, and
`ALETHIA_CRED_ENCRYPTION_KEY`. Email (`ALETHIA_SES_*`) and OAuth providers
(`GITHUB_*`/`GOOGLE_*`/`GITLAB_*`/`BITBUCKET_*`) are optional; `OPENFGA_*` is
enterprise-only.

## Database

Schema lives in `lib/db/schema/*.ts` (Drizzle). Never hand-edit generated migrations.

```bash
pnpm -F console db:generate   # diff schema → new SQL migration in lib/db/migrations/
pnpm -F console db:migrate    # apply migrations + programmables.sql (functions, RLS)
pnpm -F console db:studio     # browse the database
```

## Scripts

| Command | What |
| --- | --- |
| `pnpm -F console dev` / `build` / `start` | Next.js dev / production build / serve |
| `pnpm -F console check-types` | `tsc --noEmit` |
| `pnpm -F console lint` | ESLint |
| `pnpm -F console test` | Vitest unit tests (`test:e2e` for Playwright) |
| `pnpm -F console check:ee-boundary` | Guard: core never imports `@alethia/ee` |
| `pnpm -F console check:authz-scope` | Guard: authorize via the PDP, not ad-hoc `user_id` |
| `pnpm -F console check:no-supabase` | Guard: no Supabase references remain |

## Layout

```
app/                  Next.js App Router
  (private)/dashboard/  Authenticated UI
  (public)/auth/        Sign-in
  api/                  REST API (auth, jobs, runners, CLI)
  server/actions/       Server actions (by domain)
components/            UI (grouped by feature)
lib/
  db/                  Drizzle schema, migrations, client
  auth/                Better Auth config + session/owner helpers
  authz/               PDP, registry, grants, OpenFGA mapping
  config/              Validated env config (zod)
  cloud-providers/     AWS / GCP / Azure helpers
```
