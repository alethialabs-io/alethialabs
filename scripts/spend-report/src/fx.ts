// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EUR conversion from the European Central Bank's daily reference rates — free, keyless, and the
 * rate a EUR-denominated company would book against. `rates[c]` is units of `c` per 1 EUR, so
 * `amount / rates[c]` is EUR.
 */
export interface FxRates {
	/** The ECB publication date, or null when no rates could be read. */
	date: string | null;
	rates: Record<string, number>;
}

/** The ECB's daily reference-rate feed. */
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/** No rates at all — EUR still converts (1:1); every other currency reads as unconvertible. */
export const NO_RATES: FxRates = { date: null, rates: { EUR: 1 } };

/**
 * Parses the ECB daily XML. Returns null when the document carries no rates at all, so a changed
 * format reads as "could not convert" rather than as an empty table that converts nothing silently.
 */
export function parseEcbRates(xml: string): FxRates | null {
	const rates: Record<string, number> = { EUR: 1 };
	let n = 0;
	for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
		const code = m[1];
		const rate = Number(m[2]);
		if (code && Number.isFinite(rate) && rate > 0) {
			rates[code] = rate;
			n += 1;
		}
	}
	if (n === 0) return null;
	const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null;
	return { date, rates };
}

/** Converts `amount` of `currency` into EUR; null when the currency has no rate. */
export function toEur(amount: number, currency: string, fx: FxRates): number | null {
	const rate = fx.rates[currency.toUpperCase()];
	return rate === undefined ? null : amount / rate;
}

/** Fetches today's ECB rates; on any failure returns NO_RATES and the reason. */
export async function fetchEcbRates(): Promise<{ fx: FxRates; warning?: string }> {
	try {
		const res = await fetch(ECB_DAILY_URL, { signal: AbortSignal.timeout(20_000) });
		if (!res.ok) return { fx: NO_RATES, warning: `ECB rates unavailable (HTTP ${res.status}) — non-EUR amounts are shown in their own currency only.` };
		const parsed = parseEcbRates(await res.text());
		if (!parsed) return { fx: NO_RATES, warning: "ECB rates feed carried no rates — non-EUR amounts are shown in their own currency only." };
		return { fx: parsed };
	} catch (err) {
		return { fx: NO_RATES, warning: `ECB rates unavailable (${err instanceof Error ? err.message : String(err)}) — non-EUR amounts are shown in their own currency only.` };
	}
}
