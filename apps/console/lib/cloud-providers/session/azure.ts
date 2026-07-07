// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure session — KEYLESS. Alethia registers ONE multi-tenant Entra app whose federated-identity
// credential trusts the Alethia OIDC issuer (lib/oidc/issuer.ts); the console authenticates as that app
// against the CUSTOMER's tenant by presenting a freshly-minted assertion — no client secret anywhere.
// The customer grants the app's service principal a role on their subscription; they store nothing.

import { ClientAssertionCredential } from "@azure/identity";
import { mintWorkloadToken, oidcIssuerConfigured } from "@/lib/oidc/issuer";

/** The audience Azure AD expects for a federated-credential token exchange. */
export const AZURE_TOKEN_AUDIENCE = "api://AzureADTokenExchange";

/** Whether this instance can authenticate as the platform Azure app (app id + a working issuer). */
export function azurePlatformConfigured(): boolean {
	return !!process.env.ALETHIA_AZURE_CLIENT_ID && oidcIssuerConfigured();
}

/**
 * Builds a keyless credential for the customer tenant: the platform app id + a minted OIDC assertion as
 * the client assertion. Authenticates against `tenantId` (the CUSTOMER tenant stored on the identity),
 * NOT the app's home tenant — that's what lets one app reach every customer subscription. Throws if the
 * platform app / issuer isn't configured.
 */
export function assumeAzureIdentity(tenantId: string): ClientAssertionCredential {
	const clientId = process.env.ALETHIA_AZURE_CLIENT_ID;
	if (!clientId) {
		throw new Error("Platform Azure app is not configured (ALETHIA_AZURE_CLIENT_ID).");
	}
	if (!oidcIssuerConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}
	return new ClientAssertionCredential(tenantId, clientId, () =>
		mintWorkloadToken({ audience: AZURE_TOKEN_AUDIENCE }),
	);
}
