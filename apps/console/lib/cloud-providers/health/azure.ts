// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure health — server-side. Alethia's multi-tenant app (ALETHIA_AZURE_*) authenticates and accesses
// the customer subscription that granted it access (the managed model; mirrors the runner's federated
// identity, but from the console). Token via @azure/identity, then a cheap ARM "list locations" call.
// NOTE: requires platform Azure credentials to be configured — verifiable in a hosted/staging env, not
// in local dev without them (it returns a clear DISCONNECTED reason rather than a 5-min timeout).

import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAzureIdentity } from "../session/azure";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;
const ARM = "https://management.azure.com";

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/** Probes an Azure connection: acquire an ARM token via the platform app, then list the subscription's
 * locations (proves access to the customer subscription). Never throws. */
export async function probeAzureHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	const subscriptionId = identity.credentials.subscription_id;
	if (!subscriptionId) return disconnected("This Azure connection has no subscription id.");
	// Authenticate against the CUSTOMER tenant (stored on the identity) as the platform app, via a
	// minted OIDC assertion — keyless. `assumeAzureIdentity` throws a clear reason if the platform app
	// or issuer isn't configured on this instance.
	const tenantId = identity.credentials.tenant_id;
	if (!tenantId) return disconnected("This Azure connection has no tenant id.");

	let token: string;
	try {
		const cred = assumeAzureIdentity(tenantId);
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
