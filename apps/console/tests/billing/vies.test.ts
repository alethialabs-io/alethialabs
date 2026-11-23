// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VIES check (#7324): three answers, never two. A national register being down is
// `unavailable`, not `invalid` — refusing a real business because a server was asleep is the failure
// this file exists to avoid — and never `valid` either.

import { describe, expect, it, vi } from "vitest";
import { checkVatNumber, VIES_CHECK_URL } from "@/lib/billing/vies";
import { normaliseEuVatNumber, vatPrefixFor } from "@/lib/billing/tax-ids";

/** A fetch that answers `body` with `status`. */
function answering(status: number, body: unknown) {
	return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("normaliseEuVatNumber", () => {
	it("accepts the number with or without its own prefix, spaces and dots removed", () => {
		expect(normaliseEuVatNumber("DE", "de 123.456-789")).toEqual({
			prefix: "DE",
			number: "123456789",
			full: "DE123456789",
		});
		expect(normaliseEuVatNumber("DE", "123456789")?.full).toBe("DE123456789");
	});

	it("uses EL for Greece", () => {
		expect(vatPrefixFor("GR")).toBe("EL");
		expect(normaliseEuVatNumber("GR", "EL123456789")?.full).toBe("EL123456789");
		expect(normaliseEuVatNumber("GR", "GR123456789")).toBeNull();
	});

	it("refuses another country's prefix, and a Bulgarian number that is not 9 or 10 digits", () => {
		expect(normaliseEuVatNumber("DE", "FR12345678901")).toBeNull();
		expect(normaliseEuVatNumber("BG", "BG12345")).toBeNull();
		expect(normaliseEuVatNumber("BG", "BG1234567890")?.full).toBe("BG1234567890");
	});
});

describe("checkVatNumber", () => {
	it("asks the Commission's endpoint with the prefix and the national part", async () => {
		const fetchImpl = answering(200, { valid: true, name: "ACME GMBH", address: "---", requestIdentifier: "WAPI123" });
		const result = await checkVatNumber("DE", "DE123456789", fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith(
			VIES_CHECK_URL,
			expect.objectContaining({ method: "POST", body: JSON.stringify({ countryCode: "DE", vatNumber: "123456789" }) }),
		);
		expect(result).toMatchObject({ status: "valid", name: "ACME GMBH", address: null, requestIdentifier: "WAPI123" });
	});

	it("is `invalid` when VIES says so", async () => {
		expect((await checkVatNumber("DE", "DE123456789", answering(200, { valid: false }))).status).toBe("invalid");
	});

	it("is `invalid` without a network call for a number not formatted for the country", async () => {
		const fetchImpl = answering(200, { valid: true });
		expect((await checkVatNumber("DE", "FR123", fetchImpl)).status).toBe("invalid");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("is `unavailable` — never invalid, never valid — on an HTTP error, an odd body, or a throw", async () => {
		expect((await checkVatNumber("DE", "DE123456789", answering(500, { error: "MS_UNAVAILABLE" }))).status).toBe(
			"unavailable",
		);
		expect((await checkVatNumber("DE", "DE123456789", answering(200, { nothing: true }))).status).toBe("unavailable");
		const throwing = vi.fn(async () => {
			throw new Error("socket hang up");
		});
		expect((await checkVatNumber("DE", "DE123456789", throwing)).status).toBe("unavailable");
	});
});
