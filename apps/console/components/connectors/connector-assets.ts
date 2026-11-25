// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Single source for the cloud-connect setup constants so they aren't hardcoded
// across the per-cloud connect components — and so a self-hosted operator running on
// a different platform account / asset origin can repoint them without code changes.
//
// No hosted default reaches a self-hosted instance (EDN-H7, #6904). The one hosted-only value
// here, the public-read asset bucket, is chosen only when the instance edition contract
// (`types/edition.types.ts`, read by the `[org]` layout and given to the shell) says this is the
// hosted service. Everything else derives from the instance's own origin. Both env reads are at
// RUNTIME (`next-runtime-env`), so a prebuilt self-host image picks up its operator's values
// instead of whatever was baked in at build time.

import { env } from "next-runtime-env";
import { isHostedService, type ShellEdition } from "@/components/shell/shell-edition";
import { useShellEdition } from "@/components/shell/shell-edition-provider";

/**
 * The hosted service's public-read bucket for the connector setup artifacts
 * (`infra/connector-assets`). Used only when the edition contract says the instance IS the hosted
 * service and no origin is configured; never a fallback for a self-managed or unknown edition.
 */
const HOSTED_ASSET_ORIGIN = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com";

/** A configured origin without surrounding whitespace or trailing slashes; "" when unset. */
function trimOrigin(value: string | undefined): string {
	return (value ?? "").trim().replace(/\/+$/, "");
}

/** This instance's public app origin (`NEXT_PUBLIC_APP_URL`, read at runtime), or "" when unset. */
function appOrigin(): string {
	return trimOrigin(env("NEXT_PUBLIC_APP_URL"));
}

/**
 * Origin that serves the connector setup artifacts (alethia-{aws,gcp,azure,alibaba}-setup.sh,
 * alethia-bootstrap.yaml). In order: `NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN` when the operator set
 * it; the hosted bucket when the edition is the hosted service; otherwise this instance's own
 * origin, which serves the same files from the console's `public/`. The `curl` one-liners need an
 * absolute, publicly reachable URL — hence an origin rather than a path.
 */
export function connectorAssetOrigin(edition: ShellEdition | null): string {
	const configured = trimOrigin(env("NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN"));
	if (configured) return configured;
	return isHostedService(edition) ? HOSTED_ASSET_ORIGIN : appOrigin();
}

/** Absolute URL for a connector setup asset (e.g. `connectorAssetUrl("alethia-gcp-setup.sh", edition)`). */
export function connectorAssetUrl(file: string, edition: ShellEdition | null): string {
	return `${connectorAssetOrigin(edition)}/${file}`;
}

/**
 * The Alethia OIDC issuer URL the customer's cloud trusts (every managed cloud federates off it).
 * Derived from this instance's public app origin — `${NEXT_PUBLIC_APP_URL}/api/oidc` — so a
 * self-hosted console points its customers at its OWN issuer, and an instance with no origin set
 * yields a relative path rather than the hosted service's issuer. Keep in lockstep with
 * `issuerUrl()` (lib/oidc/issuer.ts, the server-side minter), which has no hosted default either.
 */
export function alethiaIssuerUrl(): string {
	return `${appOrigin()}/api/oidc`;
}

/** What a connect form needs to build its setup commands for this instance. */
export interface ConnectorAssets {
	/** Absolute URL for one setup asset on the origin this instance's edition resolves to. */
	assetUrl: (file: string) => string;
	/** The OIDC issuer URL the customer's cloud is told to trust. */
	issuerUrl: string;
}

/**
 * The connector asset URLs and issuer for the instance the shell is rendering, decided from the
 * instance edition the shell was given. Outside the shell the edition is unknown and the hosted
 * bucket is not used.
 */
export function useConnectorAssets(): ConnectorAssets {
	const edition = useShellEdition();
	return {
		assetUrl: (file) => connectorAssetUrl(file, edition),
		issuerUrl: alethiaIssuerUrl(),
	};
}

// Azure needs NO platform app id: the customer's setup script creates a User-Assigned Managed
// Identity in their own subscription and returns its client id, which the connect form collects
// alongside the tenant + subscription ids. Azure federates off the same issuer
// (`alethiaIssuerUrl()`) as the other managed clouds — parity with AWS/GCP/Alibaba, no
// `ALETHIA_AZURE_CLIENT_ID`.

/** Docs base for the connectors guides (per-cloud Terraform/CLI walk-throughs). */
export const CONNECTOR_DOCS_BASE = "/docs/guides/connectors";
