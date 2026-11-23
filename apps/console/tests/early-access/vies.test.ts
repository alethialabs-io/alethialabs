// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// VIES is never called for real here: every test hands `checkVatWithVies` a fake fetch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { VIES_DEFAULT_URL, checkVatWithVies } from "@/lib/early-access/vies";

/** A fake fetch that answers `body` with `status`, recording the request. */
function fakeFetch(status: number, body: unknown) {
	return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("checkVatWithVies", () => {
	it("posts the prefix and number to the published check-vat-number path", async () => {
		const f = fakeFetch(200, { valid: true, name: "ACME GMBH", address: "Berlin" });
		await checkVatWithVies("DE", "123456789", f);
		const [url, init] = f.mock.calls[0] ?? [];
		expect(url).toBe(`${VIES_DEFAULT_URL}/check-vat-number`);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({ countryCode: "DE", vatNumber: "123456789" });
	});

	it("stores valid, name, address and the consultation number", async () => {
		const r = await checkVatWithVies(
			"DE",
			"123456789",
			fakeFetch(200, { valid: true, name: " ACME GMBH ", address: "Berlin", requestIdentifier: "WAPI123" }),
		);
		expect(r).toMatchObject({
			status: "checked",
			valid: true,
			name: "ACME GMBH",
			address: "Berlin",
			requestId: "WAPI123",
		});
	});

	it("reads VIES's '---' placeholder as no value", async () => {
		const r = await checkVatWithVies("ES", "X1234567X", fakeFetch(200, { valid: true, name: "---", address: "---" }));
		expect(r).toMatchObject({ status: "checked", valid: true, name: null, address: null, requestId: null });
	});

	it("reports an invalid number as checked and not valid", async () => {
		const r = await checkVatWithVies("DE", "000000000", fakeFetch(200, { valid: false }));
		expect(r).toMatchObject({ status: "checked", valid: false });
	});

	it("is unchecked, not a refusal, when VIES answers an error", async () => {
		const r = await checkVatWithVies("DE", "123456789", fakeFetch(503, { actionSucceed: false }));
		expect(r).toEqual({ status: "unchecked", detail: "VIES answered HTTP 503" });
	});

	it("is unchecked when the body is not a VIES answer", async () => {
		const r = await checkVatWithVies("DE", "123456789", fakeFetch(200, { something: "else" }));
		expect(r.status).toBe("unchecked");
	});

	it("is unchecked when the call throws (a timeout, the network)", async () => {
		const f = vi.fn(async () => {
			throw new DOMException("timed out", "TimeoutError");
		});
		const r = await checkVatWithVies("DE", "123456789", f);
		expect(r).toEqual({ status: "unchecked", detail: "VIES call failed: TimeoutError" });
	});

	it("names a requester only when VIES_REQUESTER_VAT is configured, and honours VIES_API_URL", async () => {
		vi.stubEnv("VIES_REQUESTER_VAT", "BG 123456789");
		vi.stubEnv("VIES_API_URL", "https://vies.test/api/");
		const f = fakeFetch(200, { valid: true });
		await checkVatWithVies("DE", "123456789", f);
		const [url, init] = f.mock.calls[0] ?? [];
		expect(url).toBe("https://vies.test/api/check-vat-number");
		expect(JSON.parse(String(init?.body))).toEqual({
			countryCode: "DE",
			vatNumber: "123456789",
			requesterMemberStateCode: "BG",
			requesterNumber: "123456789",
		});
	});
});
