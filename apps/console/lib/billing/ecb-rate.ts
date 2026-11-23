// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The EUR conversion at the ECB reference rate, shared by the tax facts (lib/billing/invoice-facts.ts)
// and the фактура issuer (lib/billing/factura/). It lives apart from both ON PURPOSE: invoice-facts
// imports lib/billing/invoices.ts, which imports the фактура issuer, so an issuer that imported its
// rate from invoice-facts closed an import cycle. Whichever module a bundle entered first left the
// other half uninitialised, and `next build` failed with "Cannot access … before initialization".
// This module imports nothing from lib/billing.

import { log } from "@/lib/observability/log";

/** A conversion rate: EUR per one unit of the invoice currency, exact to 8 places, and its source. */
export interface EurRate {
	/** Decimal string with 8 places, as `invoice.eur_rate` stores it. */
	readonly eurPerUnit: string;
	/** `EUR`, or `ECB:<YYYY-MM-DD>`. */
	readonly source: string;
}

/** Looks up a rate for `currency` on the day `on`; null when none can be had. */
export type EurRateLookup = (currency: string, on: Date) => Promise<EurRate | null>;

/** The ECB's reference rates for the last 90 publication days, units of currency per EUR. */
const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

/** The currencies converted here: both use two-decimal minor units, so cents map to cents. */
const CONVERTIBLE = new Set(["usd"]);

/**
 * Picks the ECB rate for `currency` from the ECB's XML, at the latest publication date on or before
 * `on` (UTC date). The ECB quotes units of currency per EUR; the result is its inverse rounded to 8
 * places. Null when the currency or a date on or before `on` is absent.
 */
export function ecbRateFromXml(xml: string, currency: string, on: Date): EurRate | null {
	const code = currency.toUpperCase();
	const day = on.toISOString().slice(0, 10);
	let best: { date: string; rate: number } | null = null;
	for (const block of xml.split(/<Cube\s+time=/).slice(1)) {
		const date = /^["'](\d{4}-\d{2}-\d{2})["']/.exec(block)?.[1];
		if (!date || date > day) continue;
		const rate = new RegExp(`currency=["']${code}["']\\s+rate=["']([0-9.]+)["']`).exec(block)?.[1];
		const value = rate ? Number(rate) : Number.NaN;
		if (!Number.isFinite(value) || value <= 0) continue;
		if (!best || date > best.date) best = { date, rate: value };
	}
	if (!best) return null;
	return { eurPerUnit: eightPlaces(1 / best.rate), source: `ECB:${best.date}` };
}

/**
 * A positive rate as the 8-place decimal string `numeric(18, 8)` stores. This is a stored value, not
 * a figure shown to anyone, so it is built from integer arithmetic rather than a display formatter.
 */
function eightPlaces(value: number): string {
	const digits = String(Math.round(value * 1e8)).padStart(9, "0");
	return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

/**
 * The live lookup: EUR is rate 1; USD is the ECB reference rate. Any other currency, a network
 * failure, a timeout (5 s) or an answer without the rate is null — never a guess.
 */
export const ecbEurRate: EurRateLookup = async (currency, on) => {
	const code = currency.toLowerCase();
	if (code === "eur") return { eurPerUnit: "1.00000000", source: "EUR" };
	if (!CONVERTIBLE.has(code)) return null;
	try {
		const res = await fetch(ECB_RATES_URL, { signal: AbortSignal.timeout(5_000) });
		if (!res.ok) return null;
		return ecbRateFromXml(await res.text(), code, on);
	} catch (err) {
		log.warn("[billing] ECB rate lookup failed", { err });
		return null;
	}
};

/**
 * Converts an amount in `currency`'s minor unit to euro cents with `rate`, using the STORED 8-place
 * rate so that `amount × eur_rate = amount_eur_minor` can be re-checked from the row. EUR is exact.
 */
export function toEurMinor(amountMinor: number, currency: string, rate: EurRate): number {
	if (currency.toLowerCase() === "eur") return amountMinor;
	return Math.round(amountMinor * Number(rate.eurPerUnit));
}
