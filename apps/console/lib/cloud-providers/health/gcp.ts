// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP health — server-side. The customer's stored Workload Identity Federation config trusts Alethia's
// identity; google-auth-library mints an access token from it, then a cheap Compute "list regions" call
// proves access to the project. NOTE: token minting needs Alethia's OIDC subject-token source (present
// in a hosted/staging env, not local dev) — otherwise it returns a clear DISCONNECTED reason instead of
// a 5-min timeout.

import { ExternalAccountClient } from "google-auth-library";
import type { CloudIdentity } from "@/lib/db/schema";
import { ensurePlatformAwsEnv } from "../session/aws-platform";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;

function disconnected(error: string): HealthResult {
	return { status: "disconnected", accountId: null, error, missingPermissions: [] };
}

/** Probes a GCP connection via its WIF config: mint a token, then list the project's compute regions.
 * Never throws. */
export async function probeGcpHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	const wif = identity.credentials.wif_config;
	const projectId = identity.credentials.project_id;
	if (!wif) return disconnected("This GCP connection has no Workload Identity config.");
	if (!projectId) return disconnected("This GCP connection has no project id.");

	let token: string;
	try {
		// GCP federates THROUGH the platform AWS identity: google-auth's `--aws` subject-token source
		// reads the platform creds from AWS_* env. Refresh them (keyless — minted via the OIDC issuer,
		// incl. the session token) before minting the GCP token.
		await ensurePlatformAwsEnv();
		// `fromJSON` accepts an external_account credential config (the stored WIF JSON). The stored
		// shape is an opaque JSONB blob (no generated type), so this is a library-boundary cast.
		const client = ExternalAccountClient.fromJSON(
			wif as unknown as Parameters<typeof ExternalAccountClient.fromJSON>[0],
		);
		if (!client) return disconnected("The stored GCP WIF config is not a valid external account.");
		const at = await client.getAccessToken();
		if (!at.token) return disconnected("GCP token acquisition returned no token.");
		token = at.token;
	} catch (e) {
		return disconnected(`GCP authentication failed: ${errorMessage(e)}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(
			`https://compute.googleapis.com/compute/v1/projects/${projectId}/regions`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
		);
		if (res.ok) {
			return { status: "connected", accountId: projectId, error: null, missingPermissions: [] };
		}
		if (res.status === 401 || res.status === 403) {
			return {
				status: "disconnected",
				accountId: projectId,
				error: `Access to project ${projectId} was denied (HTTP ${res.status}).`,
				missingPermissions: [],
			};
		}
		return disconnected(`GCP Compute API returned HTTP ${res.status}.`);
	} catch (e) {
		return disconnected(errorMessage(e));
	} finally {
		clearTimeout(timer);
	}
}
