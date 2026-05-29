# Current State — What Changed

## Architecture Shift

The old form wrote to a single `configurations` table with 47 columns. The new form writes to `vines` + component tables via the `createVine()` server action in `app/server/actions/vines.ts`.

## What Works

- **Central Fargate worker** — deployed, running, heartbeating
- **AWS connection** — CloudFormation Launch Stack + CONNECTION_TEST verification via worker
- **AWS resource caching** — on CONNECTION_TEST, the worker fetches regions, VPCs, subnets, hosted zones and caches them in the job's `execution_metadata`. The form can read these for selectors.
- **Provision button** — on vine detail sheet, queues DEPLOY job, log viewer streams output
- **Log viewer** — real-time streaming with status badges, loading states, simulate button
- **Register Worker sheet** — UI for worker registration
- **New DB schema** — all 12 component tables created with enums, RLS, Realtime, audit log

## What's Broken / Incomplete

1. **Config form still writes to old `configurations` table** — needs to call `createVine()` instead
2. **Template repos are empty in old configs** — worker crashes on `git@:.git`. New `vine_repositories` table has defaults.
3. **Git tokens are plaintext** — old table stores `gitops_argocd_token` as text. New schema uses `vine_git_credentials` with OAuth or secret references.
4. **No multi-instance components in form** — can't add multiple databases, queues, topics. New schema supports 1:N but form doesn't yet.
5. **VPC/Region/DNS selectors use live AWS calls** — slow and fragile. Should read from cached resources.
6. **Cost sidebar is hardcoded** — should use Infracost pricing API via server action.

## Existing Form Components

Two versions exist:

1. **Legacy form** (`components/configuration-form.tsx`, 1233 lines) — monolithic, writes to `configurations`
2. **New sectioned form** (`components/configuration/`) — modular sections, has bugs (see `05-ux-issues.md`), also writes to `configurations`

Both need to be updated to call `createVine()` and write to the new component tables.
