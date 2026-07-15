// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure health — server-side. The console authenticates AS the customer's User-Assigned Managed
// Identity (its client_id is stored per-connection) against the customer's tenant, presenting a minted
// OIDC assertion as the client assertion — no platform Entra app, no client secret. Token via
// @azure/identity, then a cheap ARM read, then a capability probe that surfaces DEGRADED when
// provisioning permissions are missing (parity with the AWS/Alibaba probes). NOTE: requires the OIDC
// issuer to be configured (ALETHIA_OIDC_SIGNING_KEY); it returns a clear DISCONNECTED reason rather
// than a timeout.

import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAzureIdentity } from "../session/azure";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;
const ARM = "https://management.azure.com";

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/**
 * Turns Entra's opaque AADSTS codes into something the operator can act on. The raw strings name a
 * GUID and a trace id but never say WHICH field is wrong, so a mis-pasted id used to surface as an
 * unactionable wall of text ("Application with identifier '…' was not found in the directory").
 * Mirrors the actionable-rewrite pattern the Alibaba probe uses for stale CA fingerprints.
 */
function explainAzureAuthError(e: unknown, tenantId: string): string {
	const raw = errorMessage(e);

	// The application id isn't in the tenant at all. Overwhelmingly a mis-paste — the Subscription ID
	// looks just like a Client ID, and landing it here is the single most common Azure connect failure.
	if (raw.includes("AADSTS700016")) {
		return `No application with that Client ID exists in tenant ${tenantId}. Paste the managed identity's Client ID (\`az identity show --query clientId\`) — a Subscription ID here is the usual mistake. Original error: ${raw}`;
	}
	// The tenant itself doesn't resolve.
	if (raw.includes("AADSTS90002")) {
		return `Tenant ${tenantId} was not found. Check the Tenant ID (\`az account show --query tenantId\`). Original error: ${raw}`;
	}
	// The app exists, but no federated credential on it matches our issuer/subject/audience — i.e. the
	// trust was never established, or this console's OIDC issuer URL differs from the one the setup
	// script pinned (a self-hosted instance whose ALETHIA_APP_URL changed).
	if (raw.includes("AADSTS70021") || raw.includes("AADSTS700213")) {
		return `The managed identity has no federated credential matching this console's OIDC issuer. Re-run alethia-azure-setup.sh (it is idempotent) so the trust is (re)created against the current issuer URL, then Re-verify. Original error: ${raw}`;
	}
	return `Azure authentication failed: ${raw}`;
}

/** True when an ARM response is an authorization denial (vs a transient/network error). */
function isDenied(status: number): boolean {
	return status === 401 || status === 403;
}

/**
 * Representative ARM reads that prove the managed identity can actually see what we provision into.
 * Read-only and cheap — this is a health check, not an audit; write permissions are only truly proven
 * by a real provision.
 */
const CAPABILITY_PROBES: {
	permission: string;
	path: (sub: string) => string;
}[] = [
	{
		permission: "Microsoft.Resources/subscriptions/resourceGroups/read",
		path: (sub) => `/subscriptions/${sub}/resourcegroups?api-version=2021-04-01`,
	},
	{
		permission: "Microsoft.Network/virtualNetworks/read",
		path: (sub) =>
			`/subscriptions/${sub}/providers/Microsoft.Network/virtualNetworks?api-version=2023-05-01`,
	},
	{
		permission: "Microsoft.ContainerService/managedClusters/read",
		path: (sub) =>
			`/subscriptions/${sub}/providers/Microsoft.ContainerService/managedClusters?api-version=2024-05-01`,
	},
];

/** Probes an Azure connection: acquire an ARM token AS the customer's managed identity, list the
 * subscription's locations (proves access to the customer subscription), then probe the reads our
 * templates need (DEGRADED when denied). Never throws. */
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
		return disconnected(explainAzureAuthError(e, tenantId));
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const armGet = (path: string) =>
		fetch(`${ARM}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});

	try {
		// 1) Subscription access — the authoritative proof we can see the customer's subscription.
		const res = await armGet(
			`/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
		);
		if (!res.ok) {
			if (isDenied(res.status)) {
				return {
					status: "disconnected",
					accountId: subscriptionId,
					error: `Access to subscription ${subscriptionId} was denied (HTTP ${res.status}). Check the managed identity has a role assignment on the subscription.`,
					missingPermissions: [],
				};
			}
			return disconnected(`Azure ARM returned HTTP ${res.status}.`);
		}

		// 2) Capability probe → DEGRADED when a representative read is denied. A non-permission error
		// (network/transient) must not flip a working connection, so only denials count.
		const missingPermissions: string[] = [];
		for (const probe of CAPABILITY_PROBES) {
			try {
				const probeRes = await armGet(probe.path(subscriptionId));
				if (isDenied(probeRes.status)) missingPermissions.push(probe.permission);
			} catch {
				// Transient/aborted — ignore rather than flap the connection to DEGRADED.
			}
		}

		return {
			status: missingPermissions.length > 0 ? "degraded" : "connected",
			accountId: subscriptionId,
			error: null,
			missingPermissions,
		};
	} catch (e) {
		return disconnected(errorMessage(e));
	} finally {
		clearTimeout(timer);
	}
}
