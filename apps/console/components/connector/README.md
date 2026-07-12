<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Cloud connect sheets

This directory holds the **connect sheets** — the per-cloud flows a user runs to give Alethia
provisioning access to their cloud account. They render inside a right-side `Sheet` on the
connectors board (`components/connectors/`) and in the create-project cloud picker.

Design: the **grayscale design system** (`@repo/ui` on `@repo/brand/tokens.css`). No cards, no
shadows, no colored status fills — flat hairline `Separator`-divided sections, status shown as an
icon + label. All sheets share one scaffold, so they look identical bar their copy and fields.

## The two auth families

| Family | Clouds | Badge | Stored |
|--------|--------|-------|--------|
| **Keyless federation** | AWS, GCP, Azure, Alibaba | `Keyless` | a public trust identifier (role ARN / WIF config / tenant+subscription) — **no secret** |
| **Token clouds** | Hetzner, DigitalOcean, Civo | `Encrypted` | the customer's scoped API token, AES-GCM at rest, decrypted only on the runner |

The keyless clouds trust the Alethia OIDC issuer directly and Alethia federates in with a
short-lived minted assertion; the token clouds have no federation, so a scoped token is the ceiling.

## File map

| File | Role |
|------|------|
| `connection-ui.tsx` | **The shared scaffold.** Exports `ConnectSheetShell` (badge + intro + "How this works" popover + hairline sections), `MethodTabs` (segmented setup-method control), `Step`, `VerifySection` (+ `ConnectionTestStatus`/`StatusCallout`), and `StoredNote`. Change the look here → every sheet updates. Keep the exported props stable. |
| `{aws,gcp,azure,hetzner,extra-cloud,api-key}-connection.tsx` | **Per-cloud sheets.** Each composes the scaffold, renders its own fields, and calls an injected `onComplete`/`onSave`/`onCompleteFromIds` handler. `extra-cloud-connection.tsx` exports both `AlibabaConnection` (RAM role ARN) and `TokenCloudConnection` (generic token cloud). |
| `use-connection-test.ts` | The instant server-side verify hook. `useConnectionTest()` runs a save+verify round trip and exposes `state` (`idle`/`saving`/`success`/`failed`) → drives the shared status UI. Handlers return a `VerifyOutcome` (`verified`, `status`, `error`, `missingPermissions`). |
| `connector-assets.ts` | `connectorAssetUrl()` (setup script / template URLs), `CONNECTOR_DOCS_BASE`, `connectorDocsHref()` (maps a connector → its `/docs/console/connectors/*` page), and the pre-filled issuer/client-id env constants. |
| `../cloud-connect/use-cloud-connect.tsx` | **The host hook.** Owns the sheet open/close state, seeds/inits a pending identity, wires the per-provider save handlers to the server actions, and renders every `<Sheet>` + `ConnectSheetHeader`. Callers use `openConnect(integration)` + render `sheets`. |
| `../../lib/cloud-providers/gcp-wif.ts` | Pure WIF helper — `buildWifConfig(projectId, projectNumber)` + the fixed pool/provider/SA constants + `GCP_PROJECT_ID_REGEX`. No server deps, so the server verify **and** the client sheet import the same builder. |

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
