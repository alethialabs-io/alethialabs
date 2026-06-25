# Alethia — Development Guidelines

Do not include any Co-Authored-By or attribution lines in commit messages.

## Monorepo Conventions

- **Package manager**: pnpm 9+ with workspaces (`apps/*`, `packages/*`)
- **Task runner**: Turborepo — `turbo dev`, `turbo build`, `turbo lint`, `turbo check-types`
- **Go workspaces**: `go.work` links `apps/cli`, `apps/runner`, and `packages/core`
- **Releases**: release-please for automated versioning; GoReleaser for alethia CLI binaries and Homebrew tap

## Local stack (multi-instance rule)

The compose project name is hardcoded (`name: alethia` in `docker-compose.yml`), so **every
terminal / Claude window shares one stack** — there is never a duplicate app. The only hazard is
two `docker compose up --build` racing the same builder at once.

- **Only ever bring the stack up via `pnpm compose:up`.** It is guarded by an atomic lock
  (`scripts/compose-up.sh`): a second concurrent call no-ops and prints status instead of starting
  a duplicate build.
- **Never run `docker compose up --build` directly, and never in parallel across windows.**
- Other windows inspect the running stack with `pnpm compose:ps` / `pnpm compose:logs`.
- Default `compose:up` is the **lite** stack (`caddy app docs blog` + auto postgres/seaweedfs/migrate),
  served at `http://localhost`. The heavy `runner` (~3–5 GB, ~10–20 min build; only useful with real
  cloud creds) is opt-in via `pnpm compose:up:full`.
- `pnpm compose:down` stops the stack (keeps data); `db:reset` / `compose:down -v` wipe volumes.

### Two run modes — prefer the light one for daily work

The full dockerized stack builds heavy production images (Next.js build pegs CPU). Use it only for
end-to-end / "does the deploy work" checks. For everyday development, run the backends in Docker and
the console natively (hot-reload, no image builds, far less CPU/RAM):

- **Dev (default): `pnpm dev:up`** — one command. Brings up Postgres + SeaweedFS + OpenFGA in
  Docker, migrates, auto-provisions an OpenFGA store, then runs the console via `next dev --turbopack`
  on `http://localhost:3000` (hot reload). It **sources the root `.env`** into the console process
  (DB → `localhost:5433`, storage → `localhost:8333`, `BETTER_AUTH_SECRET`, the ngrok auth URL) and
  points `OPENFGA_API_URL` at `localhost:8082`. The OpenFGA model + tuples are written on boot by
  `instrumentation.ts` (tuple-sync `backfill()`); the store id is persisted to a gitignored
  `apps/console/.env.local`.
- **`dev:up` is lock-guarded like `compose:up`** (atomic lock at `/tmp/alethia-dev-console.lock`):
  the console is a single shared `next dev` on `:3000` across all windows/worktrees. A second
  `pnpm dev:up` **no-ops and prints the running pid + URL** instead of racing a duplicate. Follow the
  shared session from any window with **`pnpm dev:logs`** (tails `/tmp/alethia-dev-console.log`).
  Force a fresh restart (stop the old server, take over) with **`FORCE=1 pnpm dev:up`**.
- **Why not bare `pnpm dev:console`?** Next reads the app-local `apps/console/.env` (stale, no DB /
  auth / storage vars), **not** the monorepo-root `.env` — so authed pages (incl. the home page,
  which now redirects logged-in users) 500 without the wiring `dev:up` does. Use `dev:console` only
  when backends are already up *and* the env is sourced; otherwise prefer `dev:up`.
- **Backends only:** `pnpm db:up` (postgres + migrate, no seaweedfs/openfga).
- **E2E / deploy check:** `pnpm compose:up` (lite, production images at `http://localhost`).

Note: `pnpm dev` (unfiltered) runs *every* app and is heavy — use `pnpm dev:up` / `pnpm dev:console`.

### Local resource hygiene

- Don't leave unrelated Docker stacks running (e.g. a `supabase start` instance) — they idle at high
  CPU. Stop with `docker stop $(docker ps -q --filter label=com.docker.compose.project=<name>)`.
- The OrbStack VM is capped at 6 GB / 6 cores (`orb config show`) to keep macOS responsive during
  builds; changing it needs an `orb stop` to apply.

---

## Alethia (Web Control Plane)

### Database Schema Pipeline (Drizzle)

The DB tier is **Drizzle ORM + postgres-js** on self-hosted Postgres. Schema changes
follow a strict pipeline. **Never edit generated migration files manually.**

1. Edit the schema in `lib/db/schema/*.ts` (one file per domain: jobs, runners, specs, zones, …).
2. Run `pnpm -F console db:generate` — drizzle-kit diffs the schema and writes a new SQL migration to
   `lib/db/migrations/` (+ updates the `meta/` journal).
3. Migrations apply via `scripts/migrate.mjs` (the `migrate` Docker target / compose one-shot): it runs
   the generated migrations, then `lib/db/programmables.sql` (functions, triggers, RLS), then sets the
   least-privileged app-role password from `ALETHIA_APP_DB_PASSWORD`.

### How JSONB typing works

- Column types are inferred straight from the Drizzle schema (`typeof table.$inferSelect` /
  `$inferInsert`) — there is **no** generated `database.types.ts`.
- For JSONB columns with a known shape, type them on the column with
  `jsonb().$type<SomeInterface>()`; the interface lives in `types/database-custom.types.ts`
  (CloudCredentials, CachedResources, ClusterAdmin, TopicSubscription, etc.).
- **Never** use `Record<string, unknown>` for a JSONB field that has a known shape — define the
  interface in `database-custom.types.ts`.

### Zod schemas (drizzle-zod)

Derive validators from the schema with `drizzle-zod` rather than hand-writing them:

```typescript
import { createInsertSchema } from "drizzle-zod";
import { specCluster } from "@/lib/db/schema";

const clusterInsert = createInsertSchema(specCluster, {
  // refine JSONB columns with their interface types
  cluster_admins: z.custom<ClusterAdmin[]>().optional(),
  provider_config: z.custom<ClusterProviderConfig>().optional(),
});
```

Form/input schemas live in `lib/validations/`. Reusable typed query builders belong in `lib/queries/`.

### Alethia Code Style

- All functions must have a brief JSDoc comment explaining what they do.
- Group components by feature/domain, not by type. Example: `components/integrations/`, `components/design-spec/`, not `components/buttons/`, `components/modals/`.
- Component files that are renamed should be deleted, not left behind with re-exports.
- Never use `Record<string, unknown>` for JSONB fields that have a known shape. Define a proper interface in `database-custom.types.ts`.
- Prefer `useFormContext` + `useFieldArray` over prop drilling for form sections.

### Alethia Project Structure

```
apps/console/
  app/                    # Next.js app router
    (private)/dashboard/  # Authenticated routes
    (public)/auth/        # Sign-in, email confirmation
    api/                  # API routes (auth, jobs, runners, CLI)
    server/actions/       # Server actions (grouped by domain)
  components/             # UI components (grouped by feature)
  lib/
    db/                   # Drizzle schema, migrations, client (getServiceDb/withOwnerScope)
    auth/                 # Better Auth config, client, owner/session helpers
    queries/              # Reusable typed Drizzle query builders
    validations/          # Zod schemas (drizzle-zod)
    storage/              # S3-compatible object storage (@aws-sdk/client-s3)
    cloud-providers/      # AWS, GCP, Azure integration helpers
    stores/               # Zustand state stores
  types/
    database-custom.types.ts  # JSONB field interfaces ($type<>() on the schema)
```

### Alethia Key Patterns

- Cloud integrations follow the same pattern across AWS/GCP/Azure: server actions in `app/(private)/dashboard/providers/`, connection components in `components/connector/`.
- All `cloud_identities` queries must filter by `provider` to prevent cross-provider data leaks.
- The runner (Go) switches on `cloud_identity.provider` for auth — AWS uses `AssumeRole`, GCP uses WIF, Azure uses federated identity.

---

## alethia (CLI)

### Structure

- **Entry point**: `apps/cli/main.go` → `cmd.Execute()`
- **Commands** (`apps/cli/cmd/`): Cobra-based CLI with 27+ commands organized into groups:
  - **Auth**: `login`, `logout` — device code flow with browser automation, JWT tokens
  - **Zones**: `zone list|create|delete` — workspace management
  - **Specs**: `spec list|get` — infrastructure configuration browsing
  - **Jobs**: `jobs list|get|logs|cancel|wait` — provisioning job management
  - **Provisioning**: `spec plan`, `spec apply`, `spec destroy` — queue IaC operations
  - **Runners**: `runner deploy|list|destroy|remove` — runner lifecycle
  - **Clusters**: `clusters list` — Kubernetes cluster management

### Conventions

- Interactive selection uses Charmbracelet's `huh` forms with spinners during data fetching.
- Tables use Bubble Tea with keyboard navigation (`j/k`, arrows, `s` to sort, `q` to quit).
- Consistent color scheme via Lipgloss: purple (63) headers, cyan (86) accents, green (42) success, red (196) errors, gray (240) secondary.
- Version is set at build time via `-ldflags` (`internal/version/version.go`).

### Build & Release

- **GoReleaser** (`.goreleaser.yml`): cross-platform builds (Linux/macOS, amd64/arm64), Homebrew tap publishing
- **Docker** (`Dockerfile`): multi-stage alpine build with runtime deps (bash, curl, git, aws-cli, kubectl, helm), non-root `alethia` user

### Environment Variables

- `ALETHIA_WEB_ORIGIN` — Alethia control-plane URL (required; no default)
- `ALETHIA_RUNNER_OPERATOR` — Runner operator (`managed` or `self`). Legacy `ALETHIA_RUNNER_MODE` (`cloud-hosted`/`self-hosted`) still works as a back-compat fallback (cloud-hosted→managed, self-hosted→self).
- `ALETHIA_RUNNER_ID` / `ALETHIA_RUNNER_TOKEN` — Runner registration credentials
- `ALETHIA_STORAGE_ENDPOINT`, `ALETHIA_STORAGE_REGION`, `ALETHIA_STORAGE_ACCESS_KEY_ID`, `ALETHIA_STORAGE_SECRET_ACCESS_KEY` — Artifact / state storage (S3-compatible)

---

## Runner (Provisioning Agent)

- **Location**: `apps/runner/`
- **Structure**: `cmd/` (entry point), `internal/` (business logic), `internal/agent/` (job execution engine)
- **Purpose**: Long-running daemon that polls Alethia for queued provisioning jobs, claims them, executes OpenTofu operations, and streams logs back.
- **Deployment**: Docker image on ECS Fargate, auto-registered with Alethia via HTTP on startup.
- **Runner operator/provisioning**: `operator=managed` (Alethia runs it in the platform account, assumes role into customer accounts, billed by provisioned hours via the `runner_usage_sessions` ledger) or `operator=self` (runs in the customer's cloud with native permissions). Self runners are further split by `provisioning`: `deployed` (provisioned into the customer's cloud by an existing runner running Terraform) or `registered` (customer brought their own — own Terraform or `alethia runner start`).

---

## core (Shared Go Library)

- **Location**: `packages/core/`
- **Purpose**: Shared types, cloud provider interfaces, and embedded OpenTofu templates used by both alethia and Node.
- **OpenTofu templates**: Embedded in `assets/terraform/seed/` — spec provisioning templates for AWS, GCP, Azure.
- **Key packages**: Config types (SpecConfig), cloud provider abstraction (CloudProvider interface), template rendering (pongo2).

---

## docs (Documentation)

- **Location**: `apps/docs/`
- **Framework**: Next.js 16 + Fumadocs + fumadocs-mdx
- **Content**: `content/docs/` — MDX files organized by topic
- **Dev**: `turbo dev --filter=docs`

---

## Infrastructure (`infra/`)

### Managed fleet (in-app scaler)

The hosted managed runner fleet is driven by the **in-app scaler** (`apps/console/lib/fleet/`): a 60s
loop sizes per-provider warm pools by queue depth and converges them through a `FleetProvider`. The
**Hetzner** provider (`FLEET_PROVIDER=hcloud`) creates/destroys cheap VMs whose cloud-init runs a
per-cloud runner image (from GHCR) that **self-registers** via `ALETHIA_RUNNER_BOOTSTRAP_TOKEN`. The
legacy AWS ECS fleet + Lambda scaler (`infra/fleet-aws`) was retired.

### Templates (`infra/templates/`)

- `spec/aws/` — AWS EKS + VPC + RDS + security groups
- `spec/gcp/` — GCP GKE + Cloud SQL + networking
- `spec/azure/` — Azure AKS + managed resources
- `runner/aws/` — Self-hosted runner deployment template
- `argocd/` — ArgoCD configuration templates

### Connector (`infra/connector/`)

Cloud account bootstrap scripts:
- `aws/` — IAM cross-account roles and trust policies
- `gcp/` — Workload identity federation setup

---

## CI/CD (`.github/workflows/`)

- **`deploy-node.yml`** — Manual hotfix: build Node Docker image → push to ECR + GHCR → deploy to ECS
- **`release-node.yml`** — Release-please driven: tag, build, publish Node binary releases
- **`release-cli.yml`** — GoReleaser: build alethia CLI binaries, publish Homebrew tap

---

## General Rules

- Never use `any`. Use the actual type or `unknown` with proper narrowing.
- Never use `as` type casts (`as any`, `as string`, etc.). Use generated types from `database.schemas.ts`.
- Use `react-hook-form` for all form handling. Never use raw `useState` for form state.
- Use `zod` schema validation for all user inputs. No manual string matching.
- Use Tailwind CSS with shadcn/ui components. Vercel-like aesthetic: minimalist, monochrome, no excessive gradients.
- Feature planning goes in `dataroom/spec/features/` (the private `alethialabs-io/dataroom` repo) with checkable task lists.
- Never start coding without a plan and explicit approval.
