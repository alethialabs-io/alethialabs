<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Connectors

One directory for the whole connector surface: the **board** (`/{org}/~/connectors`) and the
**connect sheets** the board opens.

It was two. `components/connector/` held the sheets and `components/connectors/` held the board,
which meant a connector's tile and the flow that tile launches lived in sibling directories, and
`connectors-page.tsx` had to import across the seam. They solve one problem, so they are one
directory (#2879). No re-export shims were left behind — per `CLAUDE.md` §6 a renamed component
file is deleted, not aliased.

> **Required follow-up — two importers outside this lane's scope still point at the old path.**
> #2879's `scope:` is `components/connectors/**`, `components/connector/**` and
> `lib/stores/use-connector-filters.ts`; the two files below belong to other lanes and were
> deliberately left untouched. `@/components/connector/` no longer resolves, so until they are
> updated the console does not type-check. Each is a one-word edit — `connector/` → `connectors/`:
>
> - `apps/console/components/cloud-connect/use-cloud-connect.tsx` — lines 25, 28, 29, 30, 31, 35
>   (`connector-assets`, `aws-connection`, `azure-connection`, `gcp-connection`,
>   `hetzner-connection`, `extra-cloud-connection`)
> - `apps/console/components/design-project/canvas/inspector/connector-select.tsx` — line 30
>   (`provider-config-fields`)
>
> One prose reference is stale but harmless: `apps/console/lib/cloud-providers/azure-ids.ts:8`
> names `components/connector/azure-connection.tsx` in a comment.

## File map

### The board

| File | Role |
|------|------|
| `connectors-page.tsx` | The client page. Owns the filter pipeline, the connect/disconnect/re-verify handlers, the manage drawer and the confirm dialog. |
| `connectors-query.ts` | **Pure filter/query plumbing.** `connectorState()` (the one status ladder), `GROUP_META`, `normalizeConnectorQuery()`, `selectConnectors()`, `buildConnectorFacets()`, `buildConnectorsView()`. No React, no server imports. |
| `connectors-filter-bar.tsx` | The filter bar: `FilterSearch` + `FilterChipGroup` (status) + `FacetFilter` (group) + `MultiCombobox` (vendor) + `FilterBarReset`. |
| `connector-card.tsx` | One connector as a tile (card view). Also used by the create-project cloud picker. |
| `connector-row.tsx` | The same connector as a table row (table view). |
| `connector-detail-sheet.tsx` | The manage drawer, on `@repo/ui/detail-sheet`. |
| `connector-icon.tsx`, `git-provider-icon.tsx` | Logo rendering with monogram / mono fallbacks. |

### The connect sheets

These are the per-cloud flows a user runs to give Alethia provisioning access. They render inside a
right-side `Sheet` on the board and in the create-project cloud picker.

Design: the **grayscale design system** (`@repo/ui` on `@repo/brand/tokens.css`). No cards, no
shadows, no colored status fills — flat hairline `Separator`-divided sections, status shown as an
icon + label. All sheets share one scaffold, so they look identical bar their copy and fields.

| Family | Clouds | Badge | Stored |
|--------|--------|-------|--------|
| **Keyless federation** | AWS, GCP, Azure, Alibaba | `Keyless` | a public trust identifier (role ARN / WIF config / tenant+subscription) — **no secret** |
| **Token clouds** | Hetzner, DigitalOcean, Civo | `Encrypted` | the customer's scoped API token, AES-GCM at rest, decrypted only on the runner |

The keyless clouds trust the Alethia OIDC issuer directly and Alethia federates in with a
short-lived minted assertion; the token clouds have no federation, so a scoped token is the ceiling.

| File | Role |
|------|------|
| `connection-ui.tsx` | **The shared scaffold.** Exports `ConnectSheetShell` (badge + intro + "How this works" popover + hairline sections), `MethodTabs` (segmented setup-method control), `Step`, `VerifySection` (+ `ConnectionTestStatus`/`StatusCallout`), and `StoredNote`. Change the look here → every sheet updates. Keep the exported props stable. |
| `{aws,gcp,azure,hetzner,extra-cloud,api-key}-connection.tsx` | **Per-cloud sheets.** Each composes the scaffold, renders its own fields, and calls an injected `onComplete`/`onSave`/`onCompleteFromIds` handler. `extra-cloud-connection.tsx` exports both `AlibabaConnection` (RAM role ARN) and `TokenCloudConnection` (generic token cloud). |
| `use-connection-test.ts` | The instant server-side verify hook. `useConnectionTest()` runs a save+verify round trip and exposes `state` (`idle`/`saving`/`success`/`failed`) → drives the shared status UI. Handlers return a `VerifyOutcome` (`verified`, `status`, `error`, `missingPermissions`). |
| `provider-config-fields.tsx` | The generic `provider_config` field renderer (also used by the canvas inspector). |
| `connector-assets.ts` | `connectorAssetUrl()` (setup script / template URLs), `CONNECTOR_DOCS_BASE`, `connectorDocsHref()` (maps a connector → its `/docs/console/connectors/*` page), and the pre-filled issuer/client-id env constants. |
| `../cloud-connect/use-cloud-connect.tsx` | **The host hook.** Owns the sheet open/close state, seeds/inits a pending identity, wires the per-provider save handlers to the server actions, and renders every `<Sheet>` + `ConnectSheetHeader`. Callers use `openConnect(integration)` + render `sheets`. |
| `../../lib/cloud-providers/gcp-wif.ts` | Pure WIF helper — `buildWifConfig(projectId, projectNumber)` + the fixed pool/provider/SA constants + `GCP_PROJECT_ID_REGEX`. No server deps, so the server verify **and** the client sheet import the same builder. |

## One status ladder

`connectorState(integration, platformConfigured)` in `connectors-query.ts` is the **only** place
that decides what a connector's state is called. It returns both the words the tile prints
("Verification failed", "Limited permissions", "Verifying…") and the coarser bucket the Status
facet filters on (`connected` · `attention` · `disconnected` · `unavailable` · `coming_soon`).

The card, the row, the detail sheet and the filter bar all read it. Before, the card and the row
each carried their own copy of the same nested ternary — so a wording change had to be made twice,
and a filter written against either one could disagree with the other.

## Filtering

The board follows the console filter standard (`apps/console/lib/query/README.md` →
"Server-side filters"):

```
use-connector-filters (zustand)  →  useFilterUrlSync  →  useDebouncedValue (search)
  →  normalizeConnectorQuery()  →  qk.connectors(org, query)  →  useQuery
```

Facet counts are computed over the **unfiltered** catalog, so an option never disappears as you
select it. The Radix `<Select>` that used to drive the group filter is gone — it is banned from
filter bars.

**Known gap:** `getConnectorsWithStatus()` takes no arguments, so `selectConnectors()` and
`buildConnectorFacets()` run in the query function rather than in SQL. Both are pure and take the
same normalized query object a server-side implementation would, so moving them is a signature
change in `app/server/actions/connectors.ts` and nothing in this directory.

## The GCP "assembled config" pattern

GCP is the one cloud whose credential is a multi-line JSON blob. Rather than make the user paste it,
the sheet takes **two fields — Project ID + Project Number** — and the server assembles the
`external_account` config with `buildWifConfig` (the pool/provider/SA names are fixed connector
conventions, so the two IDs fully determine the config).

- **Why the project number is required:** the WIF audience is keyed on the *numeric* project number
  (`//iam.googleapis.com/projects/<NUMBER>/...`), not the ID, and it can't be derived without already
  being authenticated. The ID separately forms the SA email. The setup script prints both.
- **Advanced escape hatch:** a "Paste raw config JSON instead" toggle still accepts a full
  `external_account` config (e.g. `terraform output credential_config`) for custom setups.

`buildWifConfig` lives in a **pure, dep-free module** precisely so both sides share it — never fork it.

## Server side

Per-cloud server actions in `app/(private)/dashboard/providers/`:
`actions.ts` (AWS), `gcp-actions.ts`, `azure-actions.ts`, `extra-cloud-actions.ts`. Each exposes an
`initXIdentity` (seed a pending `cloud_identity` row) and `saveX` (persist + verify).

They delegate to `lib/cloud-providers/connections.ts`: `initIdentity`, `saveAwsIdentity`,
`saveGcpIdentity` / `saveGcpIdentityFromIds`, `saveAzureIdentity`, `saveAlibabaIdentity`,
`saveTokenCloudIdentity`, plus `reverifyConnection` / `disconnectIdentity`. Every save ends in the
private `verifyConnectionInline` — an **instant, server-side** auth + provisioning-permission probe
(no runner, no job) that resolves the `cloud_identity` status to `connected` / `degraded` /
`disconnected`. All queries filter by `provider` to prevent cross-provider leaks.

## Assets pipeline (single source of truth)

Setup scripts, CloudFormation templates, and Terraform modules live once under `infra/connector/*`
and are **synced** into `apps/console/public/*` by `scripts/sync-connector-assets.mjs` (the `PAIRS`
list). CI runs `scripts/check-connector-assets.mjs` (the `guards` job) to fail the build if any
public copy drifts from its source. **Edit the `infra/connector/` source, then `pnpm
sync:connector-assets`** — never hand-edit the `public/` copy.

## Product docs

Each sheet's "Docs" link resolves through `connectorDocsHref` → `CONNECTOR_DOCS_BASE`
(`/docs/console/connectors`) → the per-cloud MDX in `apps/docs/content/docs/console/connectors/`.
Keep those in sync when a flow changes (e.g. the GCP two-field flow lives in `gcp.mdx`).

## Adding a new cloud connect sheet

1. Add the setup artifact under `infra/connector/<cloud>/`, register it in the `PAIRS` list in
   `scripts/sync-connector-assets.mjs`, and run `pnpm sync:connector-assets`.
2. Write `<cloud>-connection.tsx` composing `ConnectSheetShell` + `MethodTabs` + `Step` +
   `VerifySection`; take the credential value(s) and call an injected save handler.
3. Add `initXIdentity` + `saveX` server actions and a `saveXIdentity` builder in `connections.ts`
   that ends in `verifyConnectionInline`. Filter every query by `provider`.
4. Wire it into `use-cloud-connect.tsx` (open state, handler, `<Sheet>` + `ConnectSheetHeader`).
5. Add the docs page under `apps/docs/content/docs/console/connectors/` and list it in that
   directory's `meta.json`; the `RESERVED_SLUGS`/docs mapping follow automatically.
