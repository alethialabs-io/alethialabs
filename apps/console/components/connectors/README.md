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

## File map

### The board

| File | Role |
|------|------|
| `connectors-page.tsx` | The client page. Owns the filter pipeline, the layout (`?view=`), the connect/disconnect/re-verify handlers, the manage drawer and the `?connect=` link. |
| `connectors-action.tsx` | **The one action ladder** (Connect / Manage / Reconnect / Manage + Re-verify / none) the card and the row both render. A control the viewer may not use is disabled with its reason. |
| `connectors-disconnect-dialog.tsx` | The disconnect confirmation, on `ConfirmAction`. For a cloud account it names the projects that use it and asks for the account's name. |
| `connectors-link-error.ts` | The sentence for a failed git-provider connection, shared with `components/repository-selector.tsx`. |
| `connectors-query.ts` | **Pure filter/query plumbing.** `connectorState()` (the one status ladder), `GROUP_META`, `normalizeConnectorQuery()`, `selectConnectors()`, `buildConnectorFacets()`, `buildConnectorsView()`. No React, no server imports. |
| `connectors-facets.ts` | The Status, Group and Vendor facets the page hands its one `ListToolbar` (search · facets · Reset · view toggle · docs link). |
| `connector-card.tsx` | One connector as a tile (card view). Its pick mode (`selectable`) makes a connected cloud's whole tile a choice instead of a Manage button. |
| `connector-row.tsx` | The same connector as a table row (table view). |
| `connector-detail-sheet.tsx` | The manage drawer, on `@repo/ui/detail-sheet`. |
| `connector-icon.tsx`, `git-provider-icon.tsx` | Logo rendering with monogram / mono fallbacks. |

### The connect sheets

These are the per-cloud flows a user runs to give Alethia provisioning access. Every cloud connects
through **one sheet, held in the URL**, on the shared wizard engine (`lib/wizard/`):

```
?wizard=cloud-connect&step=<cloud>
```

The URL is the sheet's open state. A refresh, Back or a shared link reopens it on the same cloud,
and the cloud's form comes back filled in from its draft. The draft keeps identifiers only (a role
ARN, a GCP project id and number, the Azure ids) and never a token or a pasted credential config.
The sheet opens from the board and from the create-project form; both call the same host hook.

Which clouds can be opened is the server's answer (`offeredClouds`, from
`lib/cloud-providers/availability.ts`). Until it arrives the build-time `AVAILABLE_CLOUDS` stands in.
A link naming a cloud that is not offered opens the sheet on a sentence saying so, with the clouds
that are offered, and never on a form the server would refuse.

Design: the **grayscale design system** (`@repo/ui` on `@repo/brand/tokens.css`). No cards, no
shadows, no colored status fills — flat hairline `Separator`-divided sections, status shown as an
icon + label. All sheets share one scaffold and one form frame, so they look identical bar their
copy and fields.

| Family | Clouds | Badge | Stored |
|--------|--------|-------|--------|
| **Keyless federation** | AWS, GCP, Azure, Alibaba | `Keyless` | a public trust identifier (role ARN / WIF config / tenant+subscription) — **no secret** |
| **Token clouds** | Hetzner, DigitalOcean, Civo | `Encrypted` | the customer's scoped API token, AES-GCM at rest, decrypted only on the runner |

The table lists every cloud that has a sheet. Which of them a deployment offers is decided by
`availability.ts`, not by this table.

The keyless clouds trust the Alethia OIDC issuer directly and Alethia federates in with a
short-lived minted assertion; the token clouds have no federation, so a scoped token is the ceiling.

#### How one connect runs

1. `openConnect(integration)` pushes `?wizard=cloud-connect&step=<cloud>`. Opening starts nothing
   on the server, so a person who looks and closes leaves no row.
2. The sheet mounts that cloud's form with a `ConnectSession`: the cloud, the draft's scope (org +
   cloud), and how to get the pending identity to save into.
3. Connect validates the form, then makes **one round trip**: it takes the host's seeded pending
   identity, or starts one with `startCloudConnect` at that moment, and calls `connectCloudAccount`,
   which saves and verifies. A retry saves into the same identity.
4. A field refusal lands on its field (the form's field names are the server's own); anything else
   is said above the button.
5. A verified connect replaces the form with the result and a primary **Done**. The host's
   `onConnected` gets the account at once, before Done, so the screen behind can select it, and the
   draft is cleared.

| File | Role |
|------|------|
| `../cloud-connect/use-cloud-connect.tsx` | **The host hook.** `useCloudConnect()` reads the sheet's open state and cloud from the URL, decides which clouds may open, holds the seeded pending identities, and renders the one `<Sheet>` (header + that cloud's form, a pending state while the offered clouds load, or the not-offered sentence). Hosts call `openConnect(integration)` and render `sheets` once. Git, api-key, manage and disconnect are not handled here; they stay on the board. |
| `../cloud-connect/cloud-connect.wizard.ts` | **The definitions.** One wizard definition per cloud, all under the wizard id `cloud-connect`, each with one step whose id is the cloud's slug. Field names are `connectCloudAccount`'s own. Also the pure helpers that read a setup script's printed output. |
| `../cloud-connect/use-connect-wizard.ts` | `useConnectWizard()` — one cloud's form on the wizard engine, wired to `connectCloudAccount` through `useConnectionTest`. Owns the one-round-trip, same-identity-on-retry and field-error placement rules above. |
| `../cloud-connect/connect-form.tsx` | `ConnectForm` — the frame every cloud's form renders inside: the restored-draft line, where the press stands, the one button, and the Done outcome. |
| `../cloud-connect/download-file.ts` | `downloadFile()` — downloads a setup script or Terraform module this console serves. |
| `connection-ui.tsx` | **The shared scaffold.** `ConnectSheetShell` (badge + intro + "How this works" popover + hairline sections), `MethodTabs` (segmented setup-method control), `Step`, `ConnectStatus` (verifying / connected / degraded / failed, said once under the form), `StatusCallout`, `InfoNote` and `StoredNote`. Change the look here → every sheet updates. |
| `{aws,gcp,azure,hetzner,extra-cloud}-connection.tsx` | **Per-cloud forms.** Each takes a `ConnectSession`, runs `useConnectWizard` with its definition, and renders its method choice, setup steps and fields inside `ConnectSheetShell` + `ConnectForm`. Each field sits in the step that produces its value. `extra-cloud-connection.tsx` exports both `AlibabaConnection` (RAM role ARN) and `TokenCloudConnection` (DigitalOcean, Civo). |
| `api-key-connection.tsx` | The api_key credential form for a pluggable connector, opened from the board. Not a cloud connect. |
| `use-connection-test.ts` | `useConnectionTest()` — runs one save + verify through `useActionMutation` (double submit ignored, board invalidated) and exposes `state` (`idle`/`saving`/`success`/`failed`) for `ConnectStatus`. |
| `provider-config-fields.tsx` | The generic `provider_config` field renderer (also used by the canvas inspector). |
| `connector-assets.ts` | `useConnectorAssets()` (setup script URLs and the OIDC issuer, decided from the instance edition: the hosted asset bucket only on the hosted service, this instance's own origin otherwise), `CONNECTOR_DOCS_BASE`. |
| `../../lib/cloud-providers/gcp-wif.ts` | Pure WIF helper — `buildWifConfig(projectId, projectNumber)` + the fixed pool/provider/SA constants + `GCP_PROJECT_ID_REGEX`. No server deps, so the server verify **and** the client form import the same builder. |

## Clouds a deployment does not offer

The board keeps no list of clouds. `connectors.board` answers `offeredClouds`, and
`connectors-query.ts` turns it into two rules:

- `acceptsNewConnections(integration, offeredClouds)` — false for a cloud card that is not offered.
  The read lists such a card only when the organization already has an account on it. The card,
  the row and the sheet then offer Manage, Re-verify, Rename and Disconnect, print one sentence why
  (`notOfferedSentence`), and offer no Connect and no "Add another account". The `?connect=` link
  is refused with the same reason.
- `listedConnectors(integrations, offeredClouds)` — leaves out a connector that signs in with the
  cluster's own cloud identity (any `auth_method` other than `api_key` and `oauth`, outside the
  cloud group) when no OFFERED cloud card has that method. A connector that takes its own credential
  is never dropped, whoever makes it. When a row is dropped the page rebuilds the rows, facets and
  total with `buildConnectorsView` for the read's own query, so no count includes it.

Both are the board's rendering only. The server is what refuses a new connection for a cloud that
is not offered (`lib/cloud-providers/availability.ts`).

## Who may change a connection

`connectors.board` answers `canManage`. A viewer without it reads the same board and the same
sheet: one line says they are read-only, Manage still opens, and every control that would change
something is drawn disabled with its reason (`DisabledReason` + `MANAGE_DENIED_REASON`).

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
  →  normalizeConnectorQuery()  →  useConnectorsQuery(query)  (lib/query/use-connectors-query.ts)
```

The normalized query is the input of ONE GET procedure, `connectors.board`
(`lib/rpc/procedures/connectors.ts`), so it is the query key. The procedure answers the matching
rows, the facet counts and the whole catalog (the manage and connect sheets look connectors up there
whatever the filter). The route prefetches the link's filter and hydrates it, so the first paint is
the board; `keepPreviousData` dims the rows while a new filter's answer is fetched. The board stays
live through the `connectors` topic on the org's change stream (`lib/query/topics.ts`, triggers in
`lib/db/programmables.sql`) — there is no poll and no `router.refresh()`.

Facet counts are computed over the **unfiltered** catalog, so an option never disappears as you
select it. The Radix `<Select>` that used to drive the group filter is gone — it is banned from
filter bars.

## Writes

Every write goes through `useActionMutation` (`lib/actions/`) over a `defineAction` server action,
and invalidates `connectorKeys()` (`connectors-board.ts`) when it settles:

| Write | Action |
|---|---|
| Start a cloud connect (the pending identity a sheet binds to) | `startCloudConnect` |
| Save + verify a cloud account | `connectCloudAccount` (one discriminated input per connect method) |
| Re-verify / rename / disconnect a cloud account | `verifyCloudAccount` / `renameCloudAccount` (the sheet's inline form) / `disconnectCloudAccount` |
| Unlink a git provider | `deleteProviderToken` |
| Save / remove an api_key credential | `saveConnectorCredential` / `deleteConnectorCredential` |

The cloud-account actions live in `app/server/actions/identities.ts`. Each authorizes
`manage_identities` and then loads the identity by id through the same scope rule the board reads
with, bound to the addressed org, before the connection library runs.

## The GCP "assembled config" pattern

GCP is the one cloud whose credential is a multi-line JSON blob. Rather than make the user paste it,
the form takes **two fields — Project ID + Project Number** — and the server assembles the
`external_account` config with `buildWifConfig` (the pool/provider/SA names are fixed connector
conventions, so the two IDs fully determine the config).

- **Why the project number is required:** the WIF audience is keyed on the *numeric* project number
  (`//iam.googleapis.com/projects/<NUMBER>/...`), not the ID, and it can't be derived without already
  being authenticated. The ID separately forms the SA email. The setup script prints both.
- **Advanced escape hatch:** a "Paste a credential config instead" toggle accepts a full
  `external_account` config (e.g. `terraform output credential_config`) for custom setups.

`buildWifConfig` lives in a **pure, dep-free module** precisely so both sides share it — never fork it.

## Server side

A connect calls two actions in `app/server/actions/identities.ts`: `startCloudConnect` (a pending
`cloud_identity` row, only when the host seeded none) and `connectCloudAccount`, whose input is one
discriminated arm per connect method (`aws`, `gcp-ids`, `gcp-wif`, `azure`, `alibaba`, `token`).

`connectCloudAccount` hands each arm to its builder in `lib/cloud-providers/connections.ts`:
`saveAwsIdentity`, `saveGcpIdentityFromIds` / `saveGcpIdentity`, `saveAzureIdentity`,
`saveAlibabaIdentity`, `saveTokenCloudIdentity`; `reverifyConnection` and `disconnectIdentity` back
Re-verify and Disconnect. Every save ends in the private `verifyConnectionInline` — an **instant,
server-side** auth + provisioning-permission probe (no runner, no job) that resolves the
`cloud_identity` status to `connected` / `degraded` / `disconnected`. All queries filter by
`provider` to prevent cross-provider leaks.

The create-project page seeds pending identities ahead of time through the per-cloud `initXIdentity`
actions in `app/(private)/dashboard/providers/` (`lib/connectors/cloud-connect-setup.ts`) and passes
them to `useCloudConnect` as `awsSetup` / `gcpSetup` / `azureSetup` / `extraSetup`. The board seeds
none.

## Assets pipeline (single source of truth)

Setup scripts, CloudFormation templates, and Terraform modules live once under `infra/connector/*`
and are **synced** into `apps/console/public/*` by `scripts/sync-connector-assets.mjs` (the `PAIRS`
list). CI runs `scripts/check-connector-assets.mjs` (the `guards` job) to fail the build if any
public copy drifts from its source. **Edit the `infra/connector/` source, then `pnpm
sync:connector-assets`** — never hand-edit the `public/` copy.

## Product docs

Each sheet's "Docs" link resolves through `connectorDocsHref` (`use-cloud-connect.tsx`) → `CONNECTOR_DOCS_BASE`
(`/docs/guides/connectors`) → the per-cloud MDX in `apps/docs/content/docs/guides/connectors/`.
Keep those in sync when a flow changes (e.g. the GCP two-field flow lives in `gcp.mdx`).

## Adding a new cloud connect sheet

1. Add the setup artifact under `infra/connector/<cloud>/`, register it in the `PAIRS` list in
   `scripts/sync-connector-assets.mjs`, and run `pnpm sync:connector-assets`.
2. Add the cloud's arm to `connectCloudAccount`'s input in `app/server/actions/identities.ts`, and a
   `saveXIdentity` builder in `connections.ts` that ends in `verifyConnectionInline`. Filter every
   query by `provider`.
3. Add its definition to `cloud-connect.wizard.ts`: one step whose id is the cloud's slug, fields
   named as the server arm names them, and a draft that lists identifiers only (or `draft: null`).
   `tests/lib/wizard/definitions.test.ts` checks it is complete and keeps no credential-shaped key.
4. Write `<cloud>-connection.tsx`: take a `ConnectSession`, call `useConnectWizard` with the
   definition and a `toInput` that builds the server arm, and render `ConnectSheetShell` +
   `ConnectForm` with `MethodTabs` / `Step` as the setup needs.
5. Add the cloud to `CONNECT_SHEETS` and `CloudConnectBody` in `use-cloud-connect.tsx`.
   `CONNECT_SHEETS` is a `Record` over the connectable clouds, so the compiler names it once the slug
   is in the catalog; the `CloudConnectBody` case is yours to add.
6. Add the docs page under `apps/docs/content/docs/guides/connectors/` and list it in that
   directory's `meta.json`; the `RESERVED_SLUGS`/docs mapping follow automatically.
