// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Health dispatcher — maps a cloud identity to its server-side probe. Every managed provider verifies
// here (auth + provisioning-capability), instantly and without a runner. There is no non-server-side
// path anymore: connections are platform-managed (hosted = Alethia's account; OSS = the operator's).

import type { CloudIdentity } from "@/lib/db/schema";
import { probeAlibabaHealth } from "./alibaba";
import { probeAwsHealth } from "./aws";
import { probeAzureHealth } from "./azure";
import { probeGcpHealth } from "./gcp";
import { probeTokenCloudHealth } from "./tokencloud";
import type { HealthResult } from "./types";

export type { HealthResult, HealthStatus } from "./types";

/** Providers with a server-side health probe. */
const SERVER_SIDE = new Set([
	"aws",
	"azure",
	"gcp",
	"alibaba",
	"digitalocean",
	"hetzner",
	"civo",
]);

/** Whether a provider has a server-side health probe. */
export function hasServerSideHealth(provider: string): boolean {
	return SERVER_SIDE.has(provider);
}

/** Token clouds whose probe needs a token Alethia actually holds. */
const TOKEN_CLOUDS = new Set(["digitalocean", "hetzner", "civo"]);

/**
 * Whether THIS identity can be probed — provider-level support plus the credentials to do it.
 *
 * A *self-managed* token cloud stores no token in Alethia (the customer holds it), so there is
 * nothing to probe. The provider-level check alone said yes, so the sweep probed it anyway, got
 * "No API token is stored for this connection." back, and flipped a perfectly good connection to
 * `disconnected` on every 10-minute tick.
 */
export function canProbeHealth(
	identity: Pick<CloudIdentity, "provider" | "credentials">,
): boolean {
	if (!hasServerSideHealth(identity.provider)) return false;
	if (TOKEN_CLOUDS.has(identity.provider) && !identity.credentials.token) {
		return false;
	}
	return true;
}

/** Probes a connection's health server-side, or null when there is nothing we can probe. */
export async function probeHealth(
	identity: Pick<CloudIdentity, "provider" | "credentials">,
): Promise<HealthResult | null> {
	if (!canProbeHealth(identity)) return null;
	switch (identity.provider) {
		case "aws":
			return probeAwsHealth(identity);
		case "azure":
			return probeAzureHealth(identity);
		case "gcp":
			return probeGcpHealth(identity);
		case "alibaba":
			return probeAlibabaHealth(identity);
		case "digitalocean":
		case "hetzner":
		case "civo":
			return probeTokenCloudHealth(identity);
		default:
			return null;
	}
}
