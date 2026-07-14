// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure health — server-side. The console authenticates AS the customer's User-Assigned Managed
// Identity (its client_id is stored per-connection) against the customer's tenant, presenting a minted
// OIDC assertion as the client assertion — no platform Entra app, no client secret. Token via
// @azure/identity, then a cheap ARM "list locations" call. NOTE: requires the OIDC issuer to be
// configured (ALETHIA_OIDC_SIGNING_KEY); it returns a clear DISCONNECTED reason rather than a timeout.

import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAzureIdentity } from "../session/azure";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;
const ARM = "https://management.azure.com";

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/** Probes an Azure connection: acquire an ARM token AS the customer's managed identity, then list the
 * subscription's locations (proves access to the customer subscription). Never throws. */
export async function probeAzureHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	const subscriptionId = identity.credentials.subscription_id;
	if (!subscriptionId) return disconnected("This Azure connection has no subscription id.");
	// Authenticate against the CUSTOMER tenant (stored on the identity) as the customer's managed
	// identity, via a minted OIDC assertion — keyless. `assumeAzureIdentity` throws a clear reason if
	// the client id is missing or the issuer isn't configured on this instance.
	const tenantId = identity.credentials.tenant_id;
	if (!tenantId) return disconnected("This Azure connection has no tenant id.");
	const clientId = identity.credentials.client_id;
	if (!clientId) return disconnected("This Azure connection has no client id.");

	let token: string;
	try {
		const cred = assumeAzureIdentity(tenantId, clientId);
		const t = await cred.getToken("https://management.azure.com/.default");
		if (!t?.token) return disconnected("Azure token acquisition returned no token.");
		token = t.token;
	} catch (e) {
		return disconnected(`Azure authentication failed: ${errorMessage(e)}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(
			`${ARM}/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
		);
		if (res.ok) {
			return {
				status: "connected",
				accountId: subscriptionId,
				error: null,
				missingPermissions: [],
			};
		}
		if (res.status === 401 || res.status === 403) {
			return {
				status: "disconnected",
				accountId: subscriptionId,
				error: `Access to subscription ${subscriptionId} was denied (HTTP ${res.status}).`,
				missingPermissions: [],
			};
		}
		return disconnected(`Azure ARM returned HTTP ${res.status}.`);
	} catch (e) {
		return disconnected(errorMessage(e));
	} finally {
		clearTimeout(timer);
	}
}
