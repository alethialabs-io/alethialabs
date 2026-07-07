// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cost model for the managed (proprietary) fleet's COGS view. Pure + unit-tested. Rates
// are approximate Hetzner Cloud list prices (EUR), used for an internal "what does the
// warm fleet cost" estimate — not an invoice. Hourly ≈ monthly / 730.

/** Approximate Hetzner Cloud hourly list price (EUR) per server type. */
export const SERVER_HOURLY_EUR: Record<string, number> = {
	// Shared ARM64 (CAX) — the fleet's default family.
	cax11: 3.79 / 730, // ~€0.0052/h
	cax21: 6.49 / 730, // ~€0.0089/h
	cax31: 12.49 / 730, // ~€0.0171/h
	cax41: 24.49 / 730, // ~€0.0335/h
	// Shared x86 (CPX) — fallback family if a pool runs amd64.
	cpx11: 4.59 / 730,
	cpx21: 8.49 / 730,
	cpx31: 16.49 / 730,
};

/** Used when a configured server type isn't in the table (keeps estimates non-zero). */
export const FALLBACK_HOURLY_EUR = SERVER_HOURLY_EUR.cax21;

/** The fleet's configured Hetzner server type (global today — no per-pool override). */
export function fleetServerType(): string {
	return process.env.HCLOUD_SERVER_TYPE ?? "cax21";
}

/** Hourly rate for a server type, falling back to the default when unknown. */
export function hourlyRateEur(serverType: string): number {
	return SERVER_HOURLY_EUR[serverType] ?? FALLBACK_HOURLY_EUR;
}

/** Estimated COGS for `provisionedHours` of a given server type (EUR). */
export function estimatePoolCostEur(provisionedHours: number, serverType: string): number {
	if (provisionedHours <= 0) return 0;
	return provisionedHours * hourlyRateEur(serverType);
}

/**
 * Warm-capacity utilization: actual busy job-minutes over the offered capacity-minutes
 * (`provisionedHours × 60 × slotsPerRunner`). Returns 0 when nothing was provisioned and
 * clamps to [0, 100] (clock skew or in-flight jobs can momentarily exceed the window).
 */
export function computeUtilizationPct(
	jobMinutes: number,
	provisionedHours: number,
	slotsPerRunner: number,
): number {
	const capacityMinutes = provisionedHours * 60 * Math.max(1, slotsPerRunner);
	if (capacityMinutes <= 0) return 0;
	const pct = (jobMinutes / capacityMinutes) * 100;
	return Math.max(0, Math.min(100, pct));
}
