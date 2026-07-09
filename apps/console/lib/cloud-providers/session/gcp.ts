// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ExternalAccountClient } from "google-auth-library";
import type { WifCredentialConfig } from "@/types/jsonb.types";

/**
 * The fixed audience the customer's GCP OIDC provider pins as its `allowed_audiences`, so a minted
 * assertion is scoped to GCP (mirrors AZURE_TOKEN_AUDIENCE / ALIBABA_TOKEN_AUDIENCE). MUST equal
 * ALETHIA_GCP_AUDIENCE in the connector setup script (gcp-setup.sh) or the token exchange is rejected.
 */
export const GCP_TOKEN_AUDIENCE = "alethia-gcp-wif";

/**
 * The `subject_token_type` of a DIRECT-OIDC WIF config — a short-lived JWT minted by the Alethia issuer,
 * with no AWS hop. The legacy AWS-hub config uses `urn:…:aws4_request` (a GetCallerIdentity request signed
 * with the platform AWS creds). `isOidcWif` selects the federation path so both keep working.
 */
export const GCP_JWT_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/** True when the stored WIF config federates directly from the Alethia OIDC issuer (vs the legacy AWS hub). */
export function isOidcWif(wif: WifCredentialConfig | null | undefined): boolean {
	return wif?.subject_token_type === GCP_JWT_SUBJECT_TOKEN_TYPE;
}

/**
 * Builds a google-auth `ExternalAccountClient` from a connection's stored WIF config. The
 * config is validated at connect time (`parseWifConfig`) but persisted as an all-optional
 * JSONB shape, so handing it to google-auth's `fromJSON` is a single library-boundary
 * assertion — centralized here rather than duplicated across the health + inventory probes.
 * Returns `null` if google-auth rejects the config as a valid external account.
 */
export function externalAccountClientFromWif(wif: WifCredentialConfig) {
	return ExternalAccountClient.fromJSON(
		wif as Parameters<typeof ExternalAccountClient.fromJSON>[0],
	);
}
