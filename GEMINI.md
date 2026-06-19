# Alethia — Development Guidelines

## Monorepo Conventions

- **Package manager**: pnpm 9+ with workspaces (`apps/*`, `packages/*`)
- **Task runner**: Turborepo — `turbo dev`, `turbo build`, `turbo lint`, `turbo check-types`
- **Go workspaces**: `go.work` links `apps/cli`, `apps/runner`, and `packages/core`
- **Releases**: release-please for automated versioning; GoReleaser for alethia CLI binaries and Homebrew tap

---

## Thesis Documentation Standards

### Citation Strategy

The thesis documentation relies on established technical literature and official cloud provider documentation. Many sections use direct quotes and summarized academic/technical concepts.

**References file**: All external sources are tracked in a separate `references.md` file under the heading **ИЗПОЛЗВАНА ЛИТЕРАТУРА**.

- **Format**: `[index] Title/Context – URL`
- **Usage**: When a definition is used in the text, the corresponding index is placed at the end of the sentence.
  - Example: "Понятието DevOps е комбинация от термините 'development' и 'operations'... [1][2]"

### Glossary of Terms

Technical terms must be shortened after their first introduction. The file `glossary.md` acts as the source of truth for these abbreviations.

| Abbreviation | Full Term |
| :--- | :--- |
| API | Application Programming Interface |
| AWS | Amazon Web Services |
| AZ | Availability Zone |
| CD | Continuous Delivery / Deployment |
| CI | Continuous Integration |
| IaC | Infrastructure as Code |
| SPA | Single Page Application |

Once a term is defined in the glossary, use the abbreviation consistently throughout the documentation.

---

## Alethia (Web Control Plane)

### Database Schema Pipeline (Drizzle)

The DB tier is **Drizzle ORM + postgres-js** on self-hosted Postgres (no Supabase). Schema changes
follow a strict pipeline. **Never edit generated migration files manually.**

1. Edit the schema in `lib/db/schema/*.ts` (one file per domain: jobs, runners, specs, zones, …).
2. Run `pnpm -F console db:generate` — drizzle-kit diffs the schema and writes a new SQL migration to
   `lib/db/migrations/` (+ updates the `meta/` journal).
3. Migrations apply via `scripts/migrate.mjs` (the `migrate` Docker target / compose one-shot): it runs
   the generated migrations, then `lib/db/programmables.sql` (functions, triggers, RLS), then sets the
   least-privileged app-role password from `ALETHIA_APP_DB_PASSWORD`.

### How JSONB typing works

- Column types are inferred straight from the Drizzle schema (`typeof table.$inferSelect` /
  `$inferInsert`) — there is **no** generated `database.types.ts` and no Supabase CLI.
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
  cluster_admins: z.custom<ClusterAdmin[]>().optional(),
  provider_config: z.custom<ClusterProviderConfig>().optional(),
});
```

Form/input schemas live in `lib/validations/`. Reusable typed query builders belong in `lib/queries/`.

### Alethia Code Style

- All functions must have a brief JSDoc comment explaining what they do.
- Group components by feature/domain, not by type. Example: `components/integrations/`, `components/plant-vine/`, not `components/buttons/`, `components/modals/`.
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
  - **Vineyards**: `vineyard list|create|delete` — workspace management
  - **Vines**: `vine list|get` — infrastructure configuration browsing
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

- `ALETHIA_WEB_ORIGIN` — API server URL (default: `https://adp.prod.itgix.eu`)
- `ALETHIA_RUNNER_MODE` — Runner mode (`self-hosted` or `cloud-hosted`)
- `ALETHIA_RUNNER_ID` / `ALETHIA_RUNNER_TOKEN` — Runner registration credentials
- `ALETHIA_STORAGE_ENDPOINT`, `ALETHIA_STORAGE_REGION`, `ALETHIA_STORAGE_ACCESS_KEY_ID`, `ALETHIA_STORAGE_SECRET_ACCESS_KEY` — Artifact / state storage (S3-compatible)

---

## Runner (Provisioning Agent)

- **Location**: `apps/runner/`
- **Structure**: `cmd/` (entry point), `internal/` (business logic), `internal/agent/` (job execution engine)
- **Purpose**: Long-running daemon that polls Alethia for queued provisioning jobs, claims them, executes Terraform operations, and streams logs back.
- **Deployment**: Docker image on ECS Fargate, auto-registered with Alethia via HTTP on startup.
- **Runner modes**: `self-hosted` (runs in customer's cloud with native permissions) or `cloud-hosted` (runs in platform account, assumes role into customer account).

---

## core (Shared Go Library)

- **Location**: `packages/core/`
- **Purpose**: Shared types, cloud provider interfaces, and embedded Terraform templates used by both alethia and Node.
- **Terraform templates**: Embedded in `assets/terraform/seed/` — vine provisioning templates for AWS, GCP, Azure.
- **Key packages**: Config types (VineConfig), cloud provider abstraction (CloudProvider interface), template rendering (pongo2).

---

## docs (Documentation)

- **Location**: `apps/docs/`
- **Framework**: Next.js 16 + Fumadocs + fumadocs-mdx
- **Content**: `content/docs/` — MDX files organized by topic
- **Dev**: `turbo dev --filter=docs`

---

## Infrastructure (`infra/`)

### Platform (`infra/platform/`)

Core infrastructure managed by Terraform:
- **ECR** (eu-west-1): Container registry for Alethia and Runner Docker images
- **ECS Fargate** (multi-region): Runner tasks in VPC, auto-registered with Alethia
- **Lambda scaler** (eu-west-1): EventBridge triggers every 1 minute, scales ECS tasks based on job queue depth

### Templates (`infra/templates/`)

- `vine/aws/` — AWS EKS + VPC + RDS + security groups
- `vine/gcp/` — GCP GKE + Cloud SQL + networking
- `vine/azure/` — Azure AKS + managed resources
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
- **`release-alethia.yml`** — GoReleaser: build alethia CLI binaries, publish Homebrew tap
- **`terraform-platform.yml`** — Validate, plan, and apply platform Terraform

---

## General Rules

- Never use `any`. Use the actual type or `unknown` with proper narrowing.
- Never use `as` type casts (`as any`, `as string`, etc.). Use generated types from `database.schemas.ts`.
- Use `react-hook-form` for all form handling. Never use raw `useState` for form state.
- Use `zod` schema validation for all user inputs. No manual string matching.
- Use Tailwind CSS with shadcn/ui components. Vercel-like aesthetic: minimalist, monochrome, no excessive gradients.
- Feature planning goes in `spec/features/` with checkable task lists.
- Never start coding without a plan and explicit approval.

---

## UI/UX Design Guidelines

- **Aesthetic**: Vercel-like — highly modern, sophisticated, not flashy.
- **Colors & Theming**: Basic shadcn/ui colors and theming. Avoid excessive gradients or overly bright, saturated colors. Keep it minimalist and monochrome/neutral where possible, prioritizing crisp typography and whitespace.

---

## Agent Workflow Rules

- **Feature Planning**: Always save progress for each feature in an `.md` file inside `spec/features/` with checkable task lists.
- **Code Proposal**: Never start proposing code without giving the full rundown of the plan beforehand and explicitly asking for approval.
