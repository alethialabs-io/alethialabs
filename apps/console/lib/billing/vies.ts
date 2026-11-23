// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// VIES — the European Commission's VAT Information Exchange System — asked whether an EU VAT number is
// registered (#7324, Early Access; TAX §3.3, `docs/legal/TAX_MARKET_PRECONDITIONS.md`).
//
// THREE answers, never two. `valid` and `invalid` are VIES's own; `unavailable` is everything else — a
// member state's register being down (VIES says `MS_UNAVAILABLE` routinely), a timeout, a response this
// file cannot read. Collapsing `unavailable` into `invalid` would refuse a real business because a
// national server was asleep; collapsing it into `valid` would record a check that never happened. The
// caller decides what each one means for its own flow, and records which one it got.
//
// The REST endpoint is the Commission's public one (no key). It is the endpoint the VIES web form
// itself calls; the SOAP service at the same host answers the same question.

import { z } from "zod";
import { normaliseEuVatNumber } from "@/lib/billing/tax-ids";
import { log } from "@/lib/observability/log";

/** The public VIES REST endpoint for a single check. */
export const VIES_CHECK_URL =
	"https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/** How long a check may take before it is `unavailable`: a purchase sheet is waiting on it. */
const VIES_TIMEOUT_MS = 8_000;

/** What VIES said about one VAT number. */
export type ViesResult =
	| {
			readonly status: "valid";
			/** The registered name, when the member state discloses it. */
			readonly name: string | null;
			/** The registered address, when the member state discloses it. */
			readonly address: string | null;
			/** VIES's consultation number — the proof the check happened. */
			readonly requestIdentifier: string | null;
			readonly checkedAt: Date;
	  }
	| { readonly status: "invalid"; readonly checkedAt: Date }
	| { readonly status: "unavailable"; readonly reason: string };

/** The fields of a VIES response this file reads; everything else is ignored. */
const viesResponse = z.object({
	valid: z.boolean(),
	name: z.string().nullish(),
	address: z.string().nullish(),
	requestIdentifier: z.string().nullish(),
});

/** VIES writes "---" for a field the member state does not disclose. */
function disclosed(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" || trimmed === "---" ? null : trimmed;
}

/**
 * Asks VIES whether `raw` is a registered VAT number for `country` (ISO 3166-1 alpha-2).
 *
 * A number that is not even FORMATTED as one for that country is `invalid` without a network call.
 * Never throws: every failure to get an answer is `unavailable`, with the reason logged.
 *
 * @param fetchImpl injectable for tests; defaults to the global `fetch`.
 */
export async function checkVatNumber(
	country: string,
	raw: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ViesResult> {
	const vat = normaliseEuVatNumber(country, raw);
	if (!vat) return { status: "invalid", checkedAt: new Date() };
	try {
		const res = await fetchImpl(VIES_CHECK_URL, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ countryCode: vat.prefix, vatNumber: vat.number }),
			signal: AbortSignal.timeout(VIES_TIMEOUT_MS),
		});
		if (!res.ok) {
			log.warn(`[vies] check answered HTTP ${res.status}`, { status: res.status });
			return { status: "unavailable", reason: `HTTP ${res.status}` };
		}
		const parsed = viesResponse.safeParse(await res.json());
		if (!parsed.success) {
			log.warn("[vies] check answered a body this client cannot read");
			return { status: "unavailable", reason: "unreadable response" };
		}
		const checkedAt = new Date();
		if (!parsed.data.valid) return { status: "invalid", checkedAt };
		return {
			status: "valid",
			name: disclosed(parsed.data.name),
			address: disclosed(parsed.data.address),
			requestIdentifier: disclosed(parsed.data.requestIdentifier),
			checkedAt,
		};
	} catch (err) {
		log.warn("[vies] check failed", { err });
		return { status: "unavailable", reason: err instanceof Error ? err.name : "network error" };
	}
}
