// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display-only splitting of a plan's price label.
 *
 * Its own module, deliberately. The obvious home was `pricing-display.ts`, but
 * that file is server-only — it imports `stripe` and `next/cache` — and the
 * pricing page is a client component (the currency toggle and the matrix search
 * are `useState`). Importing it across that boundary would pull the Stripe SDK
 * into the browser bundle. Nothing here touches either.
 *
 * Also deliberately not two new fields on `@repo/plan-catalog`: that package is
 * shared with the console's billing picker and the Stripe price-creation path,
 * and neither wants a marketing typography concern.
 */

/**
 * Split `"$20 / seat / mo"` into a large amount and a small suffix, so a tier
 * column can set the number at 44px and the unit at 12px beside it.
 *
 * Both label sources produce the same shape: the static
 * `PLAN_CATALOG.priceLabel` fallback and the live `formatSeatPrice()`, which
 * builds `` `${money} / seat / ${interval}` ``. Anything with no slash — "Free",
 * "Let's talk" — has no suffix and renders whole, which is also the safe
 * fallback if Stripe ever returns a shape this does not recognise.
 */
export function splitPriceLabel(label: string): { amount: string; suffix?: string } {
	const at = label.indexOf("/");
	if (at === -1) return { amount: label.trim() };
	const amount = label.slice(0, at).trim();
	const suffix = label.slice(at).trim();
	// A label that STARTS with a slash has no amount to enlarge — render it whole.
	return amount ? { amount, suffix } : { amount: label.trim() };
}
