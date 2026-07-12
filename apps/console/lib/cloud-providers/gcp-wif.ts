// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { WifCredentialConfig } from "@/types/jsonb.types";

// Pure GCP WIF helpers — no server deps, so both the server connection logic and the client connect
// sheet (for the live "assembled config" preview) import from here.

// Fixed connector conventions (infra/connector/gcp): the setup script / Terraform module create the
// pool/provider/service-account with these names, so a WIF config is fully determined by the project
// id + number. Advanced/custom setups paste the raw JSON instead.
export const GCP_POOL_ID = "alethia-pool";
export const GCP_PROVIDER_ID = "alethia-oidc-provider";
export const GCP_SA_NAME = "alethia-provisioner";
export const GCP_RUNNER_TOKEN_PATH = "/var/run/alethia/gcp-oidc-token";

/** GCP project id: 6–30 chars, lowercase letters/digits/hyphens, starts with a letter. */
export const GCP_PROJECT_ID_REGEX = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * Assembles the WIF `external_account` credential config from a GCP project id + number, using the
 * fixed pool/provider/service-account names the connector setup creates. Equivalent to what
 * `gcloud iam workload-identity-pools create-cred-config` prints — the user supplies just the two ids.
 */
export function buildWifConfig(
	projectId: string,
	projectNumber: string,
): WifCredentialConfig {
	const saEmail = `${GCP_SA_NAME}@${projectId}.iam.gserviceaccount.com`;
	return {
		type: "external_account",
		audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${GCP_POOL_ID}/providers/${GCP_PROVIDER_ID}`,
		subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
		token_url: "https://sts.googleapis.com/v1/token",
		service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`,
		credential_source: {
			file: GCP_RUNNER_TOKEN_PATH,
			format: { type: "text" },
		},
	};
}
