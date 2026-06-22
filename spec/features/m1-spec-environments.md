# M1 — Spec = app, Environment = deployment (`spec_environment` sub-entity)

**Decision (locked).** Move from "a spec IS one environment" (a single
`environment_stage` enum column on `specs`) to **M1**: a spec is an *app/project*
that **deploys to N environments** (dev/staging/prod/custom). Each environment is a
first-class, independently-deployable unit with its own provisioning state, jobs, and
outputs. Target URL: `/{org}/{zone}/{spec}/{env}`.

> ⚠️ **Scale + collision.** This is an epic, not a task. `environment_stage` touches
> ~50 sites across console (TS), `packages/core` (Go), the runner (Go), and the CLI
> (Go) — and it's part of the **provisioning identity** (tofu backend path, Azure RG
> name, ArgoCD facts, destroy snapshot), so it ripples into jobs + the runner claim
> flow, not just UI/routes. The route tree + migration journal are **also in live
> flux by the other instance** → do C0/C2 in a **git worktree**, coordinate the
> migration number, and land after (or carefully alongside) their header/route work.
> Migration head today = `0019` (journal idx 18 = `0018_dear_xavin`).

---

## The model

### Today
- `specs.environment_stage` — pgEnum `environment_stage` `{development|staging|production}`,
  default `development`, NOT NULL (`lib/db/schema/specs.ts:31`, `enums.ts:25`).
- A spec = one env. Provisioning identity = `(zone_id, project_name, environment_stage, region)`.

### M1 target
- **`specs`** — drop `environment_stage`. A spec is the *app* (name, zone_id,
  cloud_identity, component config). Add a `slug` (per-zone unique) for routing.
- **`spec_environments`** (NEW) — `id`, `spec_id` (FK→specs, cascade), `name`
  (slug, e.g. `dev`/`staging`/`prod`), `stage` (the existing enum, drives template
  defaults), `region`, timestamps. Unique `(spec_id, name)`. **This row is the
  deployable unit** — it owns the tofu workspace/state, jobs target it, outputs
  attach to it.
- **Provisioning identity** becomes `(zone_id, spec.slug, environment.name, region)` —
  the S3 backend path + Azure RG name + ArgoCD `Environment` all key off
  `environment.name` instead of `environment_stage`.
- **Slugs** added alongside: `zone.slug` (per-user/org unique), `spec.slug` (per-zone),
  `environment.name` (per-spec, already slug-ish). Backfill = slugify(name).

---

## Blast radius (grounded — file:line)

### Schema (2)
- `lib/db/schema/specs.ts:31` — the column · `lib/db/schema/enums.ts:25,221` — the enum + TS type.

### Console — write (3)
- `app/server/actions/specs.ts:72` (CreateSpecInput), `:192` (audit), `:669` (duplicate).
- `components/design-spec/design-spec-form.tsx:60` (form default).

### Console — read / UI (~15)
- `app/(private)/dashboard/zones/[id]/page.tsx:54-60` (Env badge column).
- `app/(private)/dashboard/zones/[id]/specs/[specId]/page.tsx:129` (header).
- `components/design-spec/section-project-basics.tsx:101-118` (the env `<Select>`),
  `review-tab.tsx:87`, `canvas/node-inspector.tsx:242`, `canvas/nodes/project-node.tsx:16`,
  `canvas/graph/form-to-graph.ts:54`, `canvas/graph/node-registry.ts:74`.
- `components/zones/spec-node.tsx`, `components/clusters/cluster-card.tsx:70`,
  `components/spec-detail/infrastructure-tab.tsx`, `spec-detail-tabs.tsx:42`,
  `components/agent/artifact-panel.tsx:286`.
- `lib/queries/spec-full.ts:30`, `lib/validations/spec-form.schema.ts:31-75`,
  `lib/validations/cli-contract.ts:59`.
- AI/util: `lib/ai/tools/read.ts`, `lib/ai/canvas-context.ts:34`, `lib/scanner/to-spec.ts:96`.
- `app/server/actions/clusters.ts:21,62,116`.

### Console — API / CLI contract (4, frozen)
- `app/api/cli/zones/route.ts:36`, `cli/configurations/route.ts:26`,
  `cli/clusters/route.ts:38` (emits `spec_environment`), `api/design-spec/ask-ai/route.ts:31`.

### Go — provisioner / runner (provisioning identity)
- `packages/core/types/spec_config.go:11` (`EnvironmentStage`), `configuration.go:12,38`, `api.go:147`.
- `packages/core/cloud/{aws,gcp,azure}_provider.go` — `environment` tfvar; `azure_provider.go:153` RG name.
- `packages/core/provisioner/deploy.go:162` — **S3 backend path** (`ProjectName + EnvironmentStage`).
- `packages/core/argocd/infra_facts.go:44` — `InfraFacts.Environment`.
- `apps/runner/internal/agent/runner.go:797` — destroy snapshot read.

### CLI (4)
- `apps/cli/cmd/spec_list.go:81`, `zone_list.go:63`, `selectors.go:91`, `pkg/utils/ui/config_printer.go:55`.

### Routes
- `/dashboard/zones/[id]` + `/specs/[specId]` (params `id`, `specId`). No env subroute today.

---

## Phased build (each shippable; check in between)

### C0a — Schema + migration `0019` *(coordinate the journal number)*
- [ ] Add `spec_environments` table to `lib/db/schema/` + relations.
- [ ] Add `slug` to `zones` + `specs` (nullable first, backfill, then unique index).
- [ ] `db:generate` → migration `0019` (do NOT hand-edit; coordinate the number with the
      other instance so it doesn't collide with their next journal entry).
- [ ] Data migration: for each existing spec, create one `spec_environments` row from its
      current `environment_stage` (name = stage), then drop the column **last** (or keep it
      nullable through a deprecation window to de-risk the Go cutover).
- [ ] Backfill slugs (slugify name, dedupe per scope).

### C0b — Provisioning identity cutover *(Go — the risky core)*
- [ ] `SpecConfig` carries `EnvironmentName` (from the env row) instead of `EnvironmentStage`;
      keep `Stage` for template defaults.
- [ ] `deploy.go` S3 backend path → `environment.name`; Azure RG → `{spec.slug}-{env.name}`;
      ArgoCD facts; destroy snapshot. **Verify state-path stability** for already-provisioned
      specs (the backfilled env name must reproduce the existing tofu state key, or plan a
      state move) — this is the single highest-risk step.
- [ ] Jobs target `(spec_id, environment_id)`; runner claim/snapshot updated.

### C0c — Console write + designer
- [ ] `createSpec` creates the spec + a default `dev` environment; add `addEnvironment`/
      `deleteEnvironment` actions.
- [ ] Designer: the env `<Select>` (`section-project-basics`) becomes an **environment
      manager** (the spec defines its environments); canvas project node reflects it.
- [ ] zod/validation + `cli-contract` updated; keep the CLI `spec_environment` field emitting
      the active env name (don't break the frozen contract).

### C1 — Vercel nav ✅ DONE (commit b3670f7; layout wiring rides the working tree)

### C2 — Slug routing + route relocation *(worktree; after C0)*
- [ ] New tree `app/(private)/[org]/[zone]/[spec]/[env]/…`; layouts resolve each slug→entity
      (verify membership; org → `setActiveOrganization`).
- [ ] `orgHref()/zoneHref()/specHref()/envHref()` helpers; breadcrumbs + both switchers +
      the new EnvSwitcher navigate by slug; reserved personal path.
- [ ] `git mv` the ~existing routes; redirect old UUID paths.

---

## Verify (per phase)
`check-types` + `eslint` + `go build ./...` + `go test ./...`; a real provision round-trip on
an existing (backfilled) spec proves the tofu state path didn't move; `/{org}/{zone}/{spec}/{env}`
resolves and all three switchers navigate by slug; light + dark.

## Open risks
1. **Tofu state path stability** (C0b) — backfilled env name must reproduce the existing S3 key,
   else every provisioned spec needs a `state mv`. De-risk: name the backfilled env exactly the
   old `environment_stage` value so the path is identical.
2. **Migration-number collision** — the other instance owns the journal; agree on `0019` vs let
   theirs land first.
3. **Frozen CLI contract** — `spec_environment` must keep emitting a single env name.
