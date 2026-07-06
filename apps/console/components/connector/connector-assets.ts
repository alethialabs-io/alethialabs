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
 * Alethia's platform AWS account id — the cross-account trust principal (AWS/Alibaba)
 * and the Azure federated-credential subject. Overridable for a self-host platform
 * account via `NEXT_PUBLIC_ALETHIA_AWS_ACCOUNT_ID`.
 */
export const ALETHIA_AWS_ACCOUNT_ID =
	process.env.NEXT_PUBLIC_ALETHIA_AWS_ACCOUNT_ID ?? "270587882865";

/** Docs base for the connectors guides (per-cloud Terraform/CLI walk-throughs). */
export const CONNECTOR_DOCS_BASE = "/docs/console/connectors";
