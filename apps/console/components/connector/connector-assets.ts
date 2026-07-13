// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Single source for the cloud-connect setup constants so they aren't hardcoded
// across the per-cloud connect components — and so a self-hosted operator running on
// a different platform account / asset origin can repoint them without code changes.

/**
 * Origin that serves the connector setup artifacts (alethia-bootstrap.yaml,
 * alethia-{gcp,azure}-setup.sh). Defaults to the hosted public-read bucket
 * (`infra/connector-assets`); a self-host can set `NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN`
 * to its own console origin (the same files ship in each app's `public/`). The CFN
 * quick-create templateURL and the `curl` one-liners need an absolute, publicly
 * reachable URL — hence an origin rather than a path.
 */
const ASSET_ORIGIN =
	process.env.NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN?.replace(/\/$/, "") ??
	"https://alethia-connector-assets.s3.eu-west-1.amazonaws.com";

/** Absolute URL for a connector setup asset (e.g. `connectorAssetUrl("alethia-gcp-setup.sh")`). */
export function connectorAssetUrl(file: string): string {
	return `${ASSET_ORIGIN}/${file}`;
}

/**
 * The Alethia OIDC issuer URL the customer's cloud trusts (every managed cloud federates off it). Derived
 * from the public app origin — `${NEXT_PUBLIC_APP_URL}/api/oidc` — so a self-hosted console points its
 * customers at its OWN issuer. Fed into the AWS CloudFormation quick-create as `param_IssuerUrl`. Keep in
 * lockstep with `issuerUrl()` (lib/oidc/issuer.ts, the server-side minter).
 */
export const ALETHIA_ISSUER_URL = `${(
	process.env.NEXT_PUBLIC_APP_URL ?? "https://alethialabs.io"
).replace(/\/+$/, "")}/api/oidc`;

// The Alethia platform Entra app id (Alethia's ONE multi-tenant app — the identity the console
// and runner authenticate as, keylessly, via a minted OIDC assertion) is NOT read from a
// `NEXT_PUBLIC_*` env var: those inline at build time, so the prod image never received it and the
// connect command shipped without the id. It's now threaded server→client as the `clientId` prop on
// <AzureConnection> (sourced from the server-only `ALETHIA_AZURE_CLIENT_ID` in `initAzureIdentity`),
// so it's runtime-configurable with no rebuild and stays a single source of truth.

/** Docs base for the connectors guides (per-cloud Terraform/CLI walk-throughs). */
export const CONNECTOR_DOCS_BASE = "/docs/console/connectors";
