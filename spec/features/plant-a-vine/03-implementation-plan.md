# Implementation Plan

## Principles

1. **Test every feature in the browser before moving on.**
2. **Form sections map 1:1 to component tables.** Each section writes to its own table.
3. **Use Supazod types.** `PublicVinesInsert`, `PublicVineVpcInsert`, etc. from `db.schemas.d.ts`.
4. **Selectors read from cached AWS data**, not live calls.
5. **Multi-instance components** (databases, queues, topics) use Add/Remove row UI pattern.

## Phase 1: Wire form to `createVine`

### 1a. Update the config form to call `createVine`

The form's `onSubmit` currently calls `createConfiguration()`. Change it to build a `CreateVineInput` object and call `createVine()`.

Map each form section to the input shape:
```typescript
const input: CreateVineInput = {
  vine: { project_name, environment_stage, aws_region, vineyard_id, cloud_identity_id },
  vpc: { provision_vpc, vpc_cidr, ... },
  eks: { cluster_version, enable_karpenter, ... },
  dns: { enabled, hosted_zone_id, domain_name, ... },
  repositories: { env_destination_repo, gitops_destination_repo, ... },
  databases: [...],
  caches: [...],
  queues: [...],
  topics: [...],
};
```

### 1b. Test: create a vine via the form

- Fill in project name, select vineyard, region
- Submit
- Verify: `vines` row exists + `vine_vpc`, `vine_eks`, `vine_dns`, `vine_repositories` rows exist
- Verify: navigate to vine detail, click Provision, see log viewer

## Phase 2: Multi-instance components in the form

### 2a. Database section — add/remove rows

Replace the single enable/disable toggle + min/max capacity with a list:
- "Add Database" button
- Each row: name, engine (dropdown), min capacity, max capacity, remove button
- On submit: each row becomes a `vine_databases` insert

### 2b. Cache section

Same pattern: "Add Cache" button, rows with name, engine (redis/valkey), node type, remove.

### 2c. Queues section

"Add Queue": name, FIFO toggle, visibility timeout.

### 2d. Topics section

"Add Topic": name, subscriptions (JSON or structured input).

## Phase 3: AWS selectors from cached data

### 3a. Read cached resources

The CONNECTION_TEST job stores `cached_resources` in `execution_metadata`. Create a server action:

```typescript
export async function getCachedAwsResources() {
  // Find the latest successful CONNECTION_TEST job for this user
  // Return its execution_metadata.cached_resources
}
```

### 3b. Region selector — from cached regions

Replace the static region list with the cached enabled regions.

### 3c. VPC selector — from cached VPCs

Show existing VPCs for the selected region. User picks one or creates new.

### 3d. DNS selector — from cached hosted zones

Read-only dropdown of Route53 hosted zones. User selects one, domain_name auto-fills.

## Phase 4: Git credentials

### 4a. Replace token inputs with `vine_git_credentials`

- ArgoCD token: show linked Git providers from OAuth (GitHub, GitLab)
- User selects provider → stores `provider_identity_id` in `vine_git_credentials`
- No plaintext tokens in the vine tables

### 4b. Test: provision with OAuth token resolution

Worker reads `vine_git_credentials` at provision time, resolves the actual token from the provider identity.

## Phase 5: Infracost in the form

### 5a. Server action for pricing

```typescript
export async function estimateComponentCost(component: string, region: string, params: Record<string, any>)
```

Calls the Infracost Cloud Pricing API, returns monthly cost.

### 5b. Cost sidebar updates live

Each component section calls `estimateComponentCost` on change (debounced). Total cost = sum of all components. Displayed in a sticky sidebar.

## Acceptance Criteria

- [ ] Form calls `createVine()` and writes to new component tables
- [ ] Vine detail page shows components with status
- [ ] Provision button works with new schema (config_snapshot has template repos)
- [ ] Multiple databases/caches/queues can be added
- [ ] AWS selectors use cached data from CONNECTION_TEST
- [ ] Git credentials use OAuth, no plaintext tokens
- [ ] Cost sidebar shows per-component estimates
- [ ] Audit log entry created on vine creation

## File Inventory

### To create/update:
- `components/configuration/configuration-form.tsx` — call `createVine` on submit
- `components/configuration/section-database.tsx` — multi-instance rows
- `components/configuration/section-advanced.tsx` — queues, topics, caches
- `app/server/actions/vines.ts` — already done
- `app/server/actions/pricing.ts` — new, Infracost API

### Existing components to reuse:
- `VineyardSelector`, `RepositorySelector`, `ContainerPlatformSelector`
- `EksVersionSelector`, `EksAdminsInput`, `CidrTagInput`
