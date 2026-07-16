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

### One worktree per instance (source isolation — enforced)

The stack is shared, but the **source tree must not be**. Multiple Claude/human sessions in the
same checkout tangle: a single `git add -A` once swept three features into one mega-commit. So:

- **`app/` (the main checkout) is pinned to `dev`** — the integration branch. **Never commit
  feature work there**, and **never `git add -A` there**.
- **Each piece of work gets its own worktree:** `pnpm wt <name>` creates a sibling
  `../wt-<name>` on `feat/<name>` off `dev`, and prints the `cd` + a free `PORT`
  (`PORT=3100 pnpm dev:up` — one console per worktree; separate `.next` = no lock clash).
  `pnpm wt:ls` lists them, `pnpm wt:rm <name>` removes one. Commit there, push, PR into `dev`.
- **This is enforced**, not just advised:
  - `.githooks/pre-commit` (wired via `core.hooksPath`, set by the root `prepare` script) blocks
    commits on `dev`/`staging`/`main`, blocks any commit in the main checkout, and runs the
    migration-chain guard when a migration is staged. `.githooks/pre-push` blocks direct pushes to
    protected branches.
  - `.claude/hooks/guard-worktree.sh` (a `PreToolUse` Bash hook) blocks a Claude instance from
    `git commit` / `git add -A` while it's launched in the main checkout.
  - **Escape hatch** (emergencies only): `git commit --no-verify` (all), or
    `ALETHIA_ALLOW_MAIN_COMMIT=1 git commit …` (the main-checkout rule only). These are for the
    maintainer — **instances must not use them.**
- **Merging into `dev`:** the `protect-dev` ruleset (`infra/github`) requires **green CI** but **no
  approval** — so once your PR's checks pass, **self-merge it**. The maintainer reviews the integrated
  `dev` (served at `dev.alethialabs.io`) and promotes `dev → staging → main`. Never merge a red PR;
  never target `staging`/`main` directly (`branch-flow-guard` blocks it).
- **Instance kickoff (parallel sessions):** if you're one of several instances, your first move is
  `pnpm wt <name>` → `cd ../wt-<name>` → work there → open a PR into `dev`, self-merge on green. One
  worktree per piece of work; never work in `app/` or touch another instance's worktree.
- **Claim work from the board (the coordination protocol):** when a program is decomposed into a
  GitHub-Issues board, don't hand-pick work — read **`.claude/COORDINATION.md`** and run
  **`scripts/claim-work.sh --class backend`** to atomically claim the next ready unit (mkdir-lock
  serialized, so no two instances grab the same one), then `pnpm wt` the printed slug. Build only within
  the issue's `scope:` globs; PR into `dev` with `Closes #<n>`; **backend self-merges on green, UI is
  human-gated** (deliverable = a data-model-grounded design spec for Claude Design, not an auto-merge).
  `scripts/coordinate.sh` reclaims dead instances' claims + reports the board.
- **Migrations stay serial:** `pnpm -F console db:generate` is lock-guarded
  (`scripts/db-generate.sh`, atomic `/tmp/alethia-migrate.lock`) and warns if you're not rebased on
  `dev` — never generate in two worktrees at once (the drizzle snapshot chain is un-mergeable; see
  the DB pipeline section).

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
  Run the console **off `:3000`** (e.g. another project owns it) with **`PORT=3100 pnpm dev:up`**
  — the lock/guard/kill all follow `$PORT`, so it won't touch whatever's on `:3000`. To tunnel a
  moved console: **`CONSOLE_PORT=3100 pnpm dev:tunnel 3100`**.
- **Public tunnel for browser/mobile testing: `pnpm dev:tunnel`** (`scripts/cf-tunnel.sh`). Opens a
  **Cloudflare quick tunnel** to the microfrontends proxy (`:3024`) — no interstitial / no throttle
  (vs ngrok-free) — prints a `*.trycloudflare.com` URL, and **restarts the console with that URL as
  its auth origin** via `ALETHIA_PUBLIC_URL` (dev-up overrides `NEXT_PUBLIC_APP_URL`/`BETTER_AUTH_URL`
  so Better Auth is same-origin). Open the printed URL (not `localhost`). Caveats: the URL is **random
  per run** and **social OAuth callbacks won't match** it → sign in with **email-OTP**; for a stable
  URL + working OAuth use a *named* tunnel (see next).
- **Stable named tunnel: `pnpm dev:tunnel:named`** (`scripts/cf-named-tunnel.sh`) — exposes the
  console at a **permanent hostname** (default `dev.alethialabs.io`; pass another as arg1) over a
  *named* Cloudflare tunnel (`alethia-dev`), and restarts the console with that hostname as its auth
  origin (same `ALETHIA_PUBLIC_URL` mechanism). One-time prereq: **`cloudflared tunnel login`** to
  authorize the zone in your Cloudflare account; the script then creates the tunnel + DNS route +
  `~/.cloudflared/config.yml` idempotently and runs it detached. Because the hostname is stable,
  **social OAuth works** once you add `https://dev.alethialabs.io/api/auth/callback/*` redirect URIs
  to your providers (email-OTP works regardless). Targets `:3000` (`CONSOLE_PORT` to override).
- **Prod-accurate stitched site over the tunnel: `pnpm dev:stitch`** (`scripts/dev-stitch.sh`) —
  serves console **+ marketing** behind the microfrontends proxy under the stable hostname, so
  `dev.alethialabs.io` behaves like hosted: **logged-out `/` → marketing landing, logged-in `/` →
  console org** (no product code — `apps/marketing/proxy.ts` + `microfrontends.json` already do this;
  console-only/OSS still correctly falls back to `/login`). Topology: `cloudflared → proxy :3024 →
  console :3100 + marketing :3010`. Console stays on `:3100` (so the `management` clone keeps `:3000`);
  since the committed `microfrontends.json` pins console to `:3000`, the script feeds the proxy a
  generated temp config (`/tmp/alethia-mfe-config.json`) with `console.local=:3100` — never edits the
  real file. Needs the `alethia-dev` tunnel from `pnpm dev:tunnel:named` first. `pnpm dev:stitch:down`
  stops marketing+proxy+tunnel (leaves console/backends/runner). Heavier than console-only (two native
  `next dev`) but far lighter than the dockerized `dev:stack`.
- **Why not bare `pnpm dev:console`?** Next reads the app-local `apps/console/.env` (stale, no DB /
  auth / storage vars), **not** the monorepo-root `.env` — so authed pages (incl. the home page,
  which now redirects logged-in users) 500 without the wiring `dev:up` does. Use `dev:console` only
  when backends are already up *and* the env is sourced; otherwise prefer `dev:up`.
- **Stripe webhooks (auto):** `dev:up` forwards **test-mode** Stripe events to the local console
  (`stripe listen → localhost:3000/api/webhooks/stripe`) whenever `STRIPE_SECRET_KEY` is set and the
  `stripe` CLI is installed (already logged in) — so trial/cancel/invoice/credit-pack flows exercise
  end-to-end. It fetches the CLI's local signing secret and exports `STRIPE_WEBHOOK_SECRET` for the
  console (overriding `.env`), and the listener dies with the console. Watch events with
  **`pnpm dev:stripe-logs`**; opt out with **`DEV_STRIPE_LISTEN=0`**. `dev:tunnel` inherits this
  (it re-execs `dev-up.sh`). For the production-image `compose:up` stack, forward manually:
  `stripe listen --forward-to http://localhost/api/webhooks/stripe` and set `.env`'s
  `STRIPE_WEBHOOK_SECRET` to its `stripe listen --print-secret`.
- **Backends only:** `pnpm db:up` (postgres + migrate, no seaweedfs/openfga).
- **Local runners: `pnpm dev:runner`** (`scripts/dev-runner.sh`) — stands up 1–2 provisioning
  runners pointed at the **native `dev:up` console** (the compose `runner` only targets the heavy
  `compose:up:full` dockerized console, so it's no use for daily work). Knobs: `RUNNERS=2`,
  `MODE=native|docker` (default native via `go build`; **`docker` bakes OpenTofu + cloud CLIs +
  templates → use it for real job execution**), `CRED=bootstrap|self` (default bootstrap), `SLOTS`,
  `PROVIDERS`, `FORCE=1`. Bootstrap auto-generates `ALETHIA_RUNNER_BOOTSTRAP_TOKEN` into `.env` on
  first run — **the console must be restarted to load it** (`FORCE=1 pnpm dev:up`); the script
  preflights this. Several runners on one host self-register distinctly via the
  `ALETHIA_RUNNER_INSTANCE_ID` override (docker uses `--hostname`). Lock-guarded like `dev:up`
  (`/tmp/alethia-dev-runner.lock`, runners run detached). `pnpm dev:runner:logs` /
  `pnpm dev:runner:down`.
- **E2E / deploy check:** `pnpm compose:up` (lite, production images at `http://localhost`).
- **Full platform, fully dockerized + tunnel + Stripe: `pnpm dev:stack`** (`scripts/dev-stack.sh`,
  `docker-compose.dev.yml`, `Dockerfile.dev`, `deploy/caddy/Caddyfile.dev`). Every Next zone runs
  `next dev` in its OWN container (source bind-mounted, file-watch **polling** — heavier CPU), **Caddy**
  stitches them like prod (mirrors `microfrontends.json`), and a **cloudflared** container fronts the
  stitched site over a Cloudflare quick tunnel while a **stripe-cli** container forwards webhooks (its
  signing secret is read from its logs + injected into the console). One command builds the shared
  `alethia-dev` image (`REBUILD=1` to rebuild after a deps change), brings up backends + all zones, and
  prints the tunnel URL. `pnpm dev:stack:logs` / `pnpm dev:stack:down`. **Heavy** — the dev image is
  multi-GB and the four `next dev` build caches add several GB; needs ample free disk (see hygiene
  below). For everyday work prefer the lighter native `dev:up`.

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

1. Edit the schema in `lib/db/schema/*.ts` (one file per domain: jobs, runners, projects, …).
2. Run `pnpm -F console db:generate` — drizzle-kit diffs the schema and writes a new SQL migration to
   `lib/db/migrations/` (+ updates the `meta/` journal).
3. Migrations apply via `scripts/migrate.mjs` (the `migrate` Docker target / compose one-shot): it runs
   the generated migrations, then `lib/db/programmables.sql` (functions, triggers, RLS), then sets the
   least-privileged app-role password from `ALETHIA_APP_DB_PASSWORD`.

**Generate migrations on ONE up-to-date branch — never in parallel.** drizzle's `meta/*_snapshot.json`
files are a single **linear chain** (each points at its parent's id) and *cannot be merged*. If two
branches / worktrees / Claude windows each run `db:generate` off the same base and then merge, two
snapshots end up with the same `prevId` → a permanent "collision" that jams `db:generate` for everyone
(and people then hand-author SQL without snapshots, compounding the drift). So:
- **Always rebase onto the target branch *before* `pnpm -F console db:generate`.** Never generate
  concurrently across windows/worktrees (the multi-instance rule applies to migrations too).
- If your branch and the target both added a migration, **delete your generated migration + snapshot,
  rebase, and re-generate** so it chains off the latest snapshot.
- `db:generate` self-checks via `scripts/check-migrations.mjs`, and CI runs `pnpm -F console
  check:migrations` (the guards job) — a forked history fails the build. Run it yourself anytime to
  verify the chain is linear.
- The runtime migrator reads only `_journal.json` + the `.sql` files (never the snapshots), so a
  one-time meta repair can safely rebuild `meta/` without touching applied history.

### How JSONB typing works

- Column types are inferred straight from the Drizzle schema (`typeof table.$inferSelect` /
  `$inferInsert`) — there is **no** generated `database.types.ts`.
- For JSONB columns with a known shape, type them on the column with
  `jsonb().$type<SomeInterface>()`; the interface lives in `types/jsonb.types.ts`
  (CloudCredentials, CachedResources, ClusterAdmin, TopicSubscription, etc.).
- **Never** use `Record<string, unknown>` for a JSONB field that has a known shape — define the
  interface in `jsonb.types.ts`.

### Zod schemas (drizzle-zod)

Derive validators from the schema with `drizzle-zod` rather than hand-writing them:

```typescript
import { createInsertSchema } from "drizzle-zod";
import { projectCluster } from "@/lib/db/schema";

const clusterInsert = createInsertSchema(projectCluster, {
  // refine JSONB columns with their interface types
  cluster_admins: z.custom<ClusterAdmin[]>().optional(),
  provider_config: z.custom<ClusterProviderConfig>().optional(),
});
```

Form/input schemas live in `lib/validations/`. Reusable typed query builders belong in `lib/queries/`.

### Alethia Code Style

- All functions must have a brief JSDoc comment explaining what they do.
- Group components by feature/domain, not by type. Example: `components/integrations/`, `components/design-project/`, not `components/buttons/`, `components/modals/`.
- Component files that are renamed should be deleted, not left behind with re-exports.
- Never use `Record<string, unknown>` for JSONB fields that have a known shape. Define a proper interface in `jsonb.types.ts`.
- Prefer `useFormContext` + `useFieldArray` over prop drilling for form sections.

### Alethia Project Structure

```
apps/console/
  app/                    # Next.js app router
    (private)/dashboard/  # Authenticated routes
    (public)/auth/        # Sign-in, email confirmation
    api/                  # API routes (auth, jobs, runners, CLI)
    server/actions/       # Server actions (grouped by domain)
  components/             # App-specific feature components (shadcn primitives are in @repo/ui)
  lib/
    db/                   # Drizzle schema, migrations, client (getServiceDb/withOwnerScope)
    auth/                 # Better Auth config, client, owner/session helpers
    queries/              # Reusable typed Drizzle query builders
    validations/          # Zod schemas (drizzle-zod)
    storage/              # S3-compatible object storage (@aws-sdk/client-s3)
    cloud-providers/      # AWS, GCP, Azure integration helpers
    stores/               # Zustand state stores
  types/
    jsonb.types.ts  # JSONB field interfaces ($type<>() on the schema)
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
  - **Projects**: `project list|get` — infrastructure configuration browsing
  - **Jobs**: `jobs list|get|logs|cancel|wait` — provisioning job management
  - **Provisioning**: `project plan`, `project apply`, `project destroy` — queue IaC operations
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
- **Verification gate (elench)**: between `tofu plan` and `tofu apply`, `provisioner.RunDeployV2` runs `packages/core/verify` over the plan JSON and attaches a `verify.Report` to the result. A real apply is **fail-closed** — a hard control failure blocks before `tofu apply` unless an authorized `verify.Override` waives it. The runner forwards the report on `execution_metadata["verify_result"]` (PLAN + DEPLOY); the console renders it in the agent artifact panel's Plan tab. See `packages/core/verify/README.md`.

---

## core (Shared Go Library)

- **Location**: `packages/core/`
- **Purpose**: Shared types, cloud provider interfaces, and embedded OpenTofu templates used by both alethia and Node.
- **OpenTofu templates**: the seed bootstrap lives in `assets/tofu/seed/`; the full per-cloud project templates are in `infra/templates/project/{aws,gcp,azure,alibaba}` (applied at provision time). Templates are parameterised by tofu variables, not rendered — `provisioner/deploy.go` copies them verbatim and writes a tfvars map (`tofu.OverrideTfvarsFromMap`) from `ProviderTfvars`.
- **Key packages**: Config types (`ProjectConfig`), cloud provider abstraction (`CloudProvider` interface → `ProviderTfvars`), ArgoCD application rendering via Go `text/template` (`argocd/render.go`), and the **`verify`** package — the deterministic, fail-closed policy gate over the OpenTofu plan JSON (keyless / least-privilege / OIDC-sub controls; honest `not_evaluable` for what the plan can't show; ed25519-signed evidence receipt). Engine-agnostic `Evaluate` seam; pure-Go in Phase 0, OPA/Rego swap-in later. The **`drift`** package turns a `plan -refresh-only -json` into a per-env drift `Posture` (the "keep proving it" half).

---

## Shared web packages (`packages/@repo/*`)

Code used by more than one web app (`apps/console`, `apps/marketing`) lives in a workspace package —
**promote shared web code to `@repo/*`; never duplicate it across the two apps.** This is how the
marketing extraction kept one source of truth (and how a redo of CI immediately caught drift).

- **`@repo/ui`** — the shared **shadcn/ui design system**: every primitive (`@repo/ui/button`,
  `@repo/ui/dialog`, …), plus `@repo/ui/utils` (`cn`), `@repo/ui/countries`, `@repo/ui/provider-icon`,
  `@repo/ui/copy-button`. Import UI from here, **not** `@/components/ui/*` (that path no longer exists).
  App-specific *feature* components still live in each app's own `components/`.
- **`@repo/brand`** — `@repo/brand/alethia-logo`, `@repo/brand/tokens.css` (the design-token
  foundation), and the brand **metadata generators** (`icon`/`apple-icon`/`opengraph-image`/
  `twitter-image`/`manifest` + `robots`/`sitemap` factories). Each app's `app/<route>` file is a thin
  re-export of these (Next.js requires one route file per app; the logic is shared).
- **`@repo/plan-catalog`** — the plan display catalog (`PLAN_CATALOG`, `planMeta`, `PlanId`); shared by
  console billing and the marketing pricing page so the copy never drifts.
- **`@repo/assets`** — static files only (`static/`: cloud/git provider icons + brand SVGs). Synced
  into each app's `public/` by `scripts/sync-public-assets.mjs` (wired into every app's `dev`/`build`,
  so it runs in local/Docker/Vercel); the synced paths are **gitignored** — the package is the single
  source. No build scripts (it's a file bundle).
- **`@repo/email`** — transactional-email infra: `@repo/email/send` (SES `sendEmail`),
  `@repo/email/config` (`getEmailConfig`), `@repo/email/components/*` (react-email building blocks).
  Email *templates* (welcome/invite/confirmation-code/alert in console, contact-lead in marketing) stay
  per-app and import these.
- **`@repo/eslint-config`, `@repo/typescript-config`** — shared lint/tsconfig presets (packages extend
  them). The Go shared library is `packages/core` (see *core* above), not a `@repo/*` package.

**Consuming a code package:** add it to the app's `transpilePackages` (`apps/<app>/next.config.ts`)
**and** `@source "../../../packages/<pkg>/src"` in the app's `app/globals.css` (so Tailwind scans its
class names). Give any **new** package `lint` + `check-types` scripts (+ `eslint.config.mjs` +
`tsconfig.json`) so the turbo-fan-out CI type-checks/lints it automatically.

---

## docs (Documentation)

- **Location**: `apps/docs/`
- **Framework**: Next.js 16 + Fumadocs + fumadocs-mdx
- **Content**: `content/docs/` — MDX files organized by topic
- **Dev**: `turbo dev --filter=docs`

---

## marketing (Public Marketing Site)

- **Location**: `apps/marketing/` (Next.js 16). The **open-source / self-hosted console ships
  NO marketing** — `apps/console` redirects `/` to sign-in. The hosted alethialabs.io site is
  `apps/marketing`: landing (`/`), `/pricing`, `/enterprise`, `/contact/*`, and the legal pages
  (`/terms`, `/privacy`, `/cookies`, `/acceptable-use`).
- **Stitching (one path map, two backends):**
  - **Hosted (Vercel):** `@vercel/microfrontends`. Console is the **default zone** (owns the
    `/{org}` wildcard + everything else); marketing is a **child zone** owning the curated root
    paths. Source of truth: `apps/console/microfrontends.json`. Console owns the bare root so
    marketing uses a custom `assetPrefix: mkt-assets` (its `next.config.ts`) to avoid `/_next/*`
    collisions. `apps/marketing/proxy.ts` bounces an authenticated `/` to the console.
  - **Off-Vercel (Caddy):** `deploy/caddy/marketing.caddy.example` mirrors the same paths +
    `mkt-assets` prefix + the authed-root cookie hand-off. Marketing is **opt-in self-host** (the
    default OSS stack still ships none): there's now an `apps/marketing/Dockerfile` (standalone,
    listens :3000) + a `marketing` compose service behind the **`marketing` profile**, and CI
    publishes `ghcr.io/alethialabs-io/marketing`. To enable: `pnpm compose:up:site` (or
    `COMPOSE_PROFILES=marketing`) **and** copy `marketing.caddy.example` → `marketing.caddy` +
    uncomment `import marketing*.caddy`. Hosted stays Vercel (native Git integration).
- **The root-namespace rule (don't hand-maintain the list):** `microfrontends.json` is the source
  of truth; `lib/marketing-zone.ts` **derives** the reserved marketing segments from it and
  `RESERVED_SLUGS` (`lib/routing.ts`) `= STATIC ∪ derived`, enforced by `isOrgSlugAvailable` so no org
  can claim e.g. `/pricing`. `scripts/check-marketing-routes.mjs` (CI `guards` job) fails if a
  marketing `app/` route isn't registered in `microfrontends.json` or the Caddy mirror drifts. To
  add/rename a marketing route: edit `microfrontends.json` + `marketing.caddy.example`; the reservation
  follows automatically.
- **Vercel project names:** the `microfrontends.json` application keys (`console`/`marketing`) must
  equal the real Vercel **project names** — adjust them (or add `packageName`) when wiring the projects.
- **Shared workspace packages:** console + marketing share `@repo/{ui,brand,plan-catalog,assets,email}`
  — see **Shared web packages** above for the full list + the consuming rules (`transpilePackages` +
  `@source`). The marketing site pulls UI, brand/logo/metadata, plan catalog, the synced static assets,
  and the email infra from those packages — no console-vs-marketing duplication.
- **Shared static assets:** `@repo/assets/static` is the single source for the provider-icon PNGs +
  brand SVGs. `scripts/sync-public-assets.mjs` copies them into each app's `public/` at `dev`/`build`
  (runs in local/Docker/Vercel via the app `build` script); the synced paths are **gitignored**.
- **Env:** `NEXT_PUBLIC_LEGAL_URL` (console legal links → marketing, default `https://alethialabs.io`),
  `NEXT_PUBLIC_SITE_URL` (marketing robots/sitemap origin), `STRIPE_SECRET_KEY` / `STRIPE_PRICE_TEAM`
  (live pricing label, falls back to the static catalog). All in `.env.example`.
- **Dev**: `turbo dev --filter=marketing` (port 3010); use the microfrontends local proxy to
  serve console + marketing under one origin.

---

## Infrastructure (`infra/`)

### Managed fleet (in-app scaler)

The hosted managed runner fleet is driven by the **in-app scaler** (`apps/console/lib/fleet/`): a 60s
loop sizes per-provider warm pools by queue depth and converges them through a `FleetProvider`. The
**Hetzner** provider (`FLEET_PROVIDER=hcloud`) creates/destroys cheap VMs whose cloud-init runs a
per-cloud runner image (from GHCR) that **self-registers** via `ALETHIA_RUNNER_BOOTSTRAP_TOKEN`. The
legacy AWS ECS fleet + Lambda scaler (`infra/fleet-aws`) was retired.

### Templates (`infra/templates/`)

- `project/aws/` — AWS EKS + VPC + RDS + security groups
- `project/gcp/` — GCP GKE + Cloud SQL + networking
- `project/azure/` — Azure AKS + managed resources
- `runner/aws/` — Self-hosted runner deployment template
- `argocd/` — ArgoCD configuration templates

### Connector (`infra/connector/`)

Cloud account bootstrap scripts:
- `aws/` — IAM cross-account roles and trust policies
- `gcp/` — Workload identity federation setup

### IaC / Terraform rules (OpenTofu)

Every change under `infra/` follows these — they keep the templates reviewable and the CI
`iac-checks` (fmt + tflint + Trivy) green:

1. **Format + validate after every change.** Run `tofu fmt -recursive`, then `tofu init` and
   `tofu validate` on each touched stack/template before committing.
2. **Add `check` blocks in `checks.tf` for all new resources** — assert the resource's invariants
   (naming, hardening, expected attributes) so drift/misconfig fails loudly.
3. **`tofu/terraform apply` and `plan -destroy` are FORBIDDEN for agents.** Only humans apply, from
   the correct branch with the required `-var`s. Never run a bare/destructive plan or apply.
4. **One file per component.** Split by resource group — `iam.tf`, `instances.tf`, `databases.tf`,
   `network.tf`, `provider.tf`, `variables.tf`, `outputs.tf`, `checks.tf` — not one monolith.
5. **Validate module/provider versions and inputs.** Check the module out (or its registry docs) and
   confirm the argument names against the pinned provider version; new components use the **latest**
   version. (e.g. azurerm 4.x renamed/removed several AKS args — validate, don't assume.)
6. **Update docs + examples every iteration.** Refresh the stack's README + `*.example` files (and
   improve them, don't just append) so they match the config.

Reviewed Trivy suppressions live in **`infra/.trivyignore`** (the mechanism Trivy honours — the
config-file `misconfiguration.exclude` key is a silent no-op), wired via `TRIVY_IGNOREFILE` in
`.github/actions/iac-checks`. Add an id there only with a one-line rationale, never to hide a real fix.

---

## CI/CD (`.github/workflows/`)

- **`ci.yml`** — PR + push gate. `check-types` / `lint` / `test` run via **turbo fan-out** across
  every workspace project that defines the script (console, marketing, docs, blog, `@alethia/ee`,
  `@repo/{ui,brand,plan-catalog,email}`) — no hardcoded app list — plus a build smoke for console ·
  marketing · docs, the Go matrix (cli/runner/core), authz/open-core guards, and gitleaks.
  (`@repo/assets` is a file bundle with no scripts, so it's intentionally not type-checked/linted.)
- **`deploy-console.yml`** — Push-to-main (path-filtered) + manual: build the self-host images
  (console, console-migrate, docs, blog, **marketing**, runner + per-cloud runners) → push to GHCR →
  SSH `compose pull && up -d` (base + `deploy/prod/docker-compose.prod.yml`).
- **`release-please.yml`** → **`release-cli.yml`** (GoReleaser: CLI binaries + Homebrew tap) and
  **`release-runner.yml`** (runner image → ECR + GHCR → ECS roll). Versioned components: CLI + runner.
- **Marketing (hosted)** deploys via **Vercel's native Git integration** (console = default zone,
  marketing = child zone); `ci.yml` is the merge gate. The `marketing` GHCR image above is the
  separate opt-in self-host path.

---

## Working discipline (every instance, at kickoff)

Reach for the right thinking tool by default — a skill only fires if you invoke it, so this is the rule that
makes the habit stick. Skills live in `.claude/skills/` and are **synced from the source-of-truth repo
`alethialabs-io/skills`** (edit them there; `bash scripts/sync-skills.sh` pulls updates) — see
`.claude/skills/README.md`.

- **Big or ambiguous task** (spans more than one session, or the approach/architecture isn't obvious) →
  **wayfind**: decompose it onto the coordination board (`.claude/COORDINATION.md`), interface-first, before
  writing code. (Reinforces "never start coding without a plan.") The board **is** our wayfinder.
- **Any non-trivial plan or spec, before building** → **grill** it first (the `grill`/`grilling` skill): an
  adversarial one-question-at-a-time pass that sharpens it and writes the resolved decisions into the
  `management/spec/features/` doc or memory. In plan mode, `AskUserQuestion` is the vehicle.
- **Unknowns — a new library, an API's real behavior, a fact you're tempted to assume** → **research** it
  against primary sources (the `research` skill for a quick cited dig; `/deep-research` for a heavy fan-out).
  Never guess where a primary source exists.
- **Security-sensitive change** (auth/authz, RLS/tenant data, secrets, keyless/credentials, the BYO-IaC
  sandbox, the `ee/` boundary, the runner, provisioning) → run **`alethia-security-review`** before shipping.
- **Handing context to another instance or a fresh session** → **handoff** (compact, redacted, references
  the claimed issue — don't re-explain what the issue/diff already says).
- **Designing a module boundary/seam** → the `codebase-design` / `domain-modeling` vocabulary (deep modules
  behind simple interfaces; the interface-first "seams" the board seeds each wave with).

## General Rules

- Never use `any`. Use the actual type or `unknown` with proper narrowing.
- Never use `as` type casts (`as any`, `as string`, etc.). Use generated types from `database.schemas.ts`.
- Use `react-hook-form` for all form handling. Never use raw `useState` for form state.
- Use `zod` schema validation for all user inputs. No manual string matching.
- Use Tailwind CSS with the shared shadcn/ui design system in **`@repo/ui`** — import `@repo/ui/button` (not `@/components/ui/button`, which no longer exists). Vercel-like aesthetic: minimalist, monochrome, no excessive gradients.
- **List-page filters follow the console filter standard** — zustand store + URL sync + debounce +
  normalized TanStack key + server-side filtering; see `apps/console/lib/query/README.md` → "Server-side filters (the standard)". Never invent per-page filter plumbing; no stat-card strips, no Selects in filter bars.
- Shared code used by more than one app lives in `packages/@repo/*` — **promote, don't duplicate** across `apps/console` ↔ `apps/marketing` (see *Shared web packages*).
- Feature planning goes in `dataroom/spec/features/` (the private `alethialabs-io/dataroom` repo) with checkable task lists.
- Never start coding without a plan and explicit approval.
- **Branch flow is `feature → dev → staging → main`.** Cut feature branches from `dev`, and open PRs
  **ONLY into `dev`**. NEVER open or merge a PR into `main` or `staging` — those receive only the
  `staging → main` / `dev → staging` promotions (or a `hotfix/*` branch). This is enforced by the
  `branch-flow-guard` required check, but don't rely on it — target `dev`.
