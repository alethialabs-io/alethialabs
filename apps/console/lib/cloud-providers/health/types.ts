// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Outcome of a server-side connection health probe (auth + provisioning-capability). */
export type HealthStatus = "connected" | "degraded" | "disconnected";

export interface HealthResult {
	status: HealthStatus;
	/** The cloud account/principal we authenticated as (proof of access), or null on failure. */
	accountId: string | null;
	/** Human-readable reason when DISCONNECTED (auth failed). */
	error: string | null;
	/** Provisioning permissions found missing → drives DEGRADED + the connectors UI hint. */
	missingPermissions: string[];
}

/** Narrows an unknown thrown error to a message. */
export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
