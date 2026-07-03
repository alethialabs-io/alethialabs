// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure health — server-side. Alethia's multi-tenant app (ALETHIA_AZURE_*) authenticates and accesses
// the customer subscription that granted it access (the managed model; mirrors the runner's federated
// identity, but from the console). Token via @azure/identity, then a cheap ARM "list locations" call.
// NOTE: requires platform Azure credentials to be configured — verifiable in a hosted/staging env, not
// in local dev without them (it returns a clear DISCONNECTED reason rather than a 5-min timeout).

import { ClientSecretCredential } from "@azure/identity";
import type { CloudIdentity } from "@/lib/db/schema";
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
	const tenantId = process.env.ALETHIA_AZURE_TENANT_ID;
	const clientId = process.env.ALETHIA_AZURE_CLIENT_ID;
	const clientSecret = process.env.ALETHIA_AZURE_CLIENT_SECRET;
	if (!tenantId || !clientId || !clientSecret) {
		return disconnected(
			"Platform Azure credentials are not configured (ALETHIA_AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET).",
		);
	}
	const subscriptionId = identity.credentials.subscription_id;
	if (!subscriptionId) return disconnected("This Azure connection has no subscription id.");

	let token: string;
	try {
		const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
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
