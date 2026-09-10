// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cost model for the managed (proprietary) fleet's COGS view. Pure + unit-tested. Rates are
// Hetzner Cloud list prices (EUR, gross), used for an internal "what does the warm fleet cost"
// estimate — not an invoice.
//
// MEASURED 2026-09-09 against the Hetzner API, not against a web page or `cloud_data.json`:
//
//     hcloud server-type describe <type> -o json   # .prices[] per location
//
// Re-measure with that command when you touch this table, and move `MEASURED_ON` with it. The
// previous table was built from `cloud_data.json` — which is Hetzner's marketing COMPARISON file,
// not its price list — and every one of its seven entries had drifted low, the CAX family by
// 58-68% (#4412). `cax21` is both the fleet's default (hcloud.ts DEFAULT_SERVER_TYPES) and the
// unknown-type fallback below, so the largest error was the one applied most often.
//
// PRICES ARE THE SAME IN EVERY LOCATION a type is sold in, which is why this is keyed by type
// alone. Checked across fsn1/nbg1/hel1 for CAX and fsn1/nbg1/hel1/ash/hil/sin for CPX. The
// FAMILIES differ in reach, and that is a placement fact rather than a pricing one: CAX (ARM) is
// EU-only, so a pool that lists a US location cannot run the fleet's preferred type there.

/** The date the rates below were read from the Hetzner API. Move it when you re-measure. */
export const MEASURED_ON = "2026-09-09";

/**
 * Hetzner Cloud list price per server type: hourly, and the MONTHLY CAP.
 *
 * Both, because Hetzner bills hourly *capped at the monthly price* — it does not bill
 * `monthly / 730`. This file used to derive hourly that way and it is the wrong direction: for
 * `cax21`, `0.0168 × 730 = €12.26` against a €10.49 cap, so a server held a full month costs 14%
 * LESS than an hourly model predicts, and the gap widens the longer it is held.
 */
export interface ServerPriceEur {
	/** Gross EUR per hour, as billed until the monthly cap is reached. */
	hourly: number;
	/** Gross EUR per month — the cap a single continuously-held server never exceeds. */
	monthlyCap: number;
}

export const SERVER_PRICE_EUR: Record<string, ServerPriceEur> = {
	// Shared ARM64 (CAX) — the fleet's default family. EU locations only (fsn1, hel1, nbg1).
	cax11: { hourly: 0.0096, monthlyCap: 5.99 },
	cax21: { hourly: 0.0168, monthlyCap: 10.49 },
	cax31: { hourly: 0.0336, monthlyCap: 20.99 },
	cax41: { hourly: 0.0657, monthlyCap: 40.99 },
	// Shared x86 (CPX) — the capacity fallback when ARM has none. Also ash, hil, sin.
	cpx11: { hourly: 0.0088, monthlyCap: 5.49 },
	cpx21: { hourly: 0.0152, monthlyCap: 9.49 },
	cpx31: { hourly: 0.028, monthlyCap: 17.49 },
	cpx41: { hourly: 0.0521, monthlyCap: 32.49 },
};

/** Approximate Hetzner Cloud hourly list price (EUR) per server type. */
export const SERVER_HOURLY_EUR: Record<string, number> = Object.fromEntries(
	Object.entries(SERVER_PRICE_EUR).map(([type, p]) => [type, p.hourly]),
);

/** Used when a configured server type isn't in the table (keeps estimates non-zero).
 *
 *  It is `cax21` because that is what `fleetServerType()` defaults to, so an unset
 *  `HCLOUD_SERVER_TYPES` prices the type it will actually run. That also means a genuinely unknown
 *  type is priced as the CHEAPEST family — an under-estimate, not a conservative one. The test
 *  below pins that every type `hcloud.ts` can place is in the table, so the fallback is reached
 *  only by a type nothing selects. */
export const FALLBACK_HOURLY_EUR = SERVER_PRICE_EUR.cax21.hourly;

/** The fleet's PRIMARY (preferred) Hetzner server type for the cost view — the first of the
 *  failover preference list (`HCLOUD_SERVER_TYPES`), i.e. the type a pool runs when capacity is
 *  healthy. Honours the legacy single `HCLOUD_SERVER_TYPE`; the actual placement may fall back to a
 *  pricier x86 type when ARM is out, but the estimate tracks the intended steady state. */
export function fleetServerType(): string {
	const first = (process.env.HCLOUD_SERVER_TYPES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)[0];
	return first ?? process.env.HCLOUD_SERVER_TYPE ?? "cax21";
}

/** Hourly rate for a server type, falling back to the default when unknown. */
export function hourlyRateEur(serverType: string): number {
	return SERVER_HOURLY_EUR[serverType] ?? FALLBACK_HOURLY_EUR;
}

/**
 * Estimated COGS for `provisionedHours` of a given server type (EUR).
 *
 * NO MONTHLY CAP IS APPLIED, and that is deliberate rather than an omission. `provisionedHours` is
 * an AGGREGATE — `provisionedHoursByProvider` sums every managed session in the window and groups
 * by provider (lib/queries/runner-usage.ts) — so 800 hours may be one server held a month or 800
 * servers held an hour. Those have completely different bills, and `min(hours × hourly, cap)` on
 * the aggregate would cap a fleet of 800 short-lived servers at ONE server's monthly price, which
 * is wrong by three orders of magnitude in the direction that hides spend.
 *
 * So this is hours × hourly: exact for short-lived servers, and an UPPER BOUND for long-held ones
 * (at most 730/roughly-624 ≈ 17% high for a server held a full month). Capping soundly needs
 * per-server hours; `provisionedHoursByProvider` already returns `runner_count`, so the input
 * exists and only the plumbing does not — see {@link cappedMonthlyCostEur} for the one-server case.
 */
export function estimatePoolCostEur(provisionedHours: number, serverType: string): number {
	if (provisionedHours <= 0) return 0;
	return provisionedHours * hourlyRateEur(serverType);
}

/**
 * What ONE continuously-held server of `serverType` costs for `hours` — the capped figure.
 *
 * This is the number the "hold CCX/CPX continuously" question turns on (#4359): a held server is
 * billed hourly until it reaches the monthly price and then stops. Only correct for a SINGLE
 * server, which is why {@link estimatePoolCostEur} does not use it.
 */
export function cappedMonthlyCostEur(hours: number, serverType: string): number {
	if (hours <= 0) return 0;
	const price = SERVER_PRICE_EUR[serverType] ?? SERVER_PRICE_EUR.cax21;
	const months = Math.floor(hours / 730);
	const remainder = hours - months * 730;
	return months * price.monthlyCap + Math.min(remainder * price.hourly, price.monthlyCap);
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
