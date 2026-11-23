// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VIES check for an Early Access request (EA-3, #7325; TAX §3.3).
//
// THE ENDPOINT. The European Commission's public VIES REST API, `POST /check-vat-number` under
// `https://ec.europa.eu/taxation_customs/vies/rest-api`. The path and the request and response fields
// below are the ones in the Commission's published OpenAPI document
// (https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml, read 2026-11-23); the
// host is the one that document's API is served from. Overridable with `VIES_API_URL` so a test or
// a future move of the service needs no code change.
//
// THE CONSULTATION NUMBER. VIES returns `requestIdentifier` only when the request names a requester
// (`requesterMemberStateCode` + `requesterNumber`), and a requester must itself hold a VAT number.
// The seller is not VAT-registered (`LEGAL_ENTITY.vatRegistered` is false), so today no requester is
// sent and `requestId` is null. `VIES_REQUESTER_VAT` (for example `BG123456789`) turns it on the day
// the seller is registered, without a code change.
//
// FAILURE IS NOT REFUSAL. Anything other than a well-formed 200 answer — a timeout, a 5xx, a member
// state that is down, a body that does not parse — is reported as `unchecked`. The caller stores the
// request as unchecked and does not refuse it: a request the Commission's service could not answer
// is still a request.

import { z } from "zod";

/** The default VIES REST base URL. */
export const VIES_DEFAULT_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";

/** How long a VIES call may take before the request is stored as unchecked. */
const VIES_TIMEOUT_MS = 8_000;

/** What VIES said about a number. */
export type ViesResult =
	| {
			readonly status: "checked";
			readonly valid: boolean;
			/** The registered name, or null when VIES withholds it (some member states do). */
			readonly name: string | null;
			readonly address: string | null;
			/** VIES's consultation number; null when no requester was named (see the file header). */
			readonly requestId: string | null;
			readonly checkedAt: Date;
	  }
	| { readonly status: "unchecked"; readonly detail: string };

/** The fields of VIES's `CheckVatResponse` this check reads. */
const checkVatResponse = z.object({
	valid: z.boolean(),
	name: z.string().nullish(),
	address: z.string().nullish(),
	requestIdentifier: z.string().nullish(),
});

/**
 * VIES writes `---` for a field a member state withholds. That is not a name, so it is stored as
 * NULL rather than shown to staff as if it were one.
 */
function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed || /^-+$/.test(trimmed)) return null;
	return trimmed;
}

/** The requester VIES is told about, from `VIES_REQUESTER_VAT`, or null when none is configured. */
function requester(): { requesterMemberStateCode: string; requesterNumber: string } | null {
	const raw = process.env.VIES_REQUESTER_VAT?.replace(/\s/g, "").toUpperCase();
	if (!raw) return null;
	const match = /^([A-Z]{2})([0-9A-Z]{2,12})$/.exec(raw);
	if (!match) return null;
	return { requesterMemberStateCode: match[1], requesterNumber: match[2] };
}

/**
 * Checks one VAT number against VIES. Never throws: every failure is an `unchecked` result with a
 * short detail for the log.
 *
 * @param viesCountryCode the VIES prefix (`EL` for Greece).
 * @param number the number without its prefix.
 */
export async function checkVatWithVies(
	viesCountryCode: string,
	number: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ViesResult> {
	const base = (process.env.VIES_API_URL?.trim() || VIES_DEFAULT_URL).replace(/\/$/, "");
	try {
		const res = await fetchImpl(`${base}/check-vat-number`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				countryCode: viesCountryCode,
				vatNumber: number,
				...(requester() ?? {}),
			}),
			signal: AbortSignal.timeout(VIES_TIMEOUT_MS),
			cache: "no-store",
		});
		if (!res.ok) return { status: "unchecked", detail: `VIES answered HTTP ${res.status}` };
		const parsed = checkVatResponse.safeParse(await res.json());
		if (!parsed.success) return { status: "unchecked", detail: "VIES answered an unreadable body" };
		return {
			status: "checked",
			valid: parsed.data.valid,
			name: present(parsed.data.name),
			address: present(parsed.data.address),
			requestId: present(parsed.data.requestIdentifier),
			// The server's clock, not VIES's `requestDate`: that field can be a bare date.
			checkedAt: new Date(),
		};
	} catch (err) {
		// A timeout is a DOMException, which is not an `Error` in every runtime; read its name either way.
		const name =
			typeof err === "object" && err !== null && "name" in err && typeof err.name === "string"
				? err.name
				: null;
		return { status: "unchecked", detail: name ? `VIES call failed: ${name}` : "VIES call failed" };
	}
}
