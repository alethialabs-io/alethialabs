// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EA-7 (#7323): the console accepts a фактура as the invoice only when Art. 113-114 of the VAT Act
// allows it — a ten-digit Arabic-digit number, a posted document, the recipient's details, and the
// no-VAT ground of the cell (Art. 113(9) for an unregistered supplier). Every other answer, and no
// answer at all, comes back as a named reason instead of null, so nothing downstream can mistake a
// failure for "use Stripe's PDF".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FacturaSource,
	isLegalInvoiceNumber,
	issueFactura,
	missingRecipientDetails,
	NO_VAT_GROUND_UNREGISTERED,
	noVatGround,
	requestFactura,
} from "@/lib/billing/odoo-invoice";

const UNREGISTERED = { vatRegistered: false };
const REGISTERED = { vatRegistered: true };

/** A Stripe invoice with every Art. 114(1) recipient detail present; `over` replaces fields. */
function source(over: Partial<FacturaSource> = {}): FacturaSource {
	return {
		id: "in_1",
		currency: "usd",
		customer_name: "Acme GmbH",
		customer_address: {
			line1: "Hauptstraße 1",
			line2: null,
			city: "Berlin",
			postal_code: "10115",
			state: null,
			country: "DE",
		},
		customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
		...over,
	};
}

/** A compliant Odoo answer; `over` replaces fields. */
function odooAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ok: true,
		number: "0000000042",
		currency: "USD",
		state: "posted",
		payment_state: "paid",
		vat_ground: NO_VAT_GROUND_UNREGISTERED,
		pdf_base64: Buffer.from("%PDF-фактура").toString("base64"),
		...over,
	};
}

const fetchMock = vi.fn();

/** Makes the next fetch answer with `body` and HTTP `status`. */
function answerWith(body: unknown, status = 200): void {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
	);
}

/** The failure reason of an outcome, or "ok" — so an assertion reads as one value. */
async function reasonOf(inv: FacturaSource, supplier = UNREGISTERED): Promise<string> {
	const outcome = await requestFactura(inv, supplier);
	return outcome.ok ? "ok" : outcome.reason;
}

describe("isLegalInvoiceNumber (Art. 114(1), point 2)", () => {
	it("accepts exactly ten Arabic digits", () => {
		expect(isLegalInvoiceNumber("0000000001")).toBe(true);
		expect(isLegalInvoiceNumber("1234567890")).toBe(true);
	});

	it.each([
		["Odoo's default sequence", "INV/2026/00001"],
		["Stripe's prefix-hyphen-sequence", "OQDLWV3B-0031"],
		["nine digits", "123456789"],
		["eleven digits", "12345678901"],
		["Arabic-Indic digits, which are not Arabic numerals", "١٢٣٤٥٦٧٨٩٠"],
		["a padded number", " 0000000001"],
		["empty", ""],
	])("refuses %s", (_label, value) => {
		expect(isLegalInvoiceNumber(value)).toBe(false);
	});

	it("refuses a missing number", () => {
		expect(isLegalInvoiceNumber(null)).toBe(false);
		expect(isLegalInvoiceNumber(undefined)).toBe(false);
	});
});

describe("noVatGround (the ground per cell)", () => {
	it("is Art. 113(9) for a supplier not registered under the VAT Act", () => {
		expect(noVatGround(UNREGISTERED)).toBe("чл. 113, ал. 9 ЗДДС");
	});

	it("is not ruled for a registered supplier, so nothing is guessed", () => {
		expect(noVatGround(REGISTERED)).toBeNull();
	});

	it("reads the company's real status by default (unregistered today)", () => {
		expect(noVatGround()).toBe(NO_VAT_GROUND_UNREGISTERED);
	});
});

describe("missingRecipientDetails (Art. 114(1) recipient)", () => {
	it("is empty when name, address and an identification number are present", () => {
		expect(missingRecipientDetails(source())).toEqual([]);
	});

	it("names a missing or blank name", () => {
		expect(missingRecipientDetails(source({ customer_name: null }))).toEqual(["name"]);
		expect(missingRecipientDetails(source({ customer_name: "  " }))).toEqual(["name"]);
	});

	it("names an address with no street, city or country", () => {
		expect(missingRecipientDetails(source({ customer_address: null }))).toEqual(["address"]);
		const base = source().customer_address;
		if (!base) throw new Error("fixture has an address");
		expect(missingRecipientDetails(source({ customer_address: { ...base, line1: null } }))).toEqual(["address"]);
		expect(missingRecipientDetails(source({ customer_address: { ...base, city: "" } }))).toEqual(["address"]);
		expect(missingRecipientDetails(source({ customer_address: { ...base, country: null } }))).toEqual(["address"]);
	});

	it("names a missing identification number, and accepts a register number as one", () => {
		expect(missingRecipientDetails(source({ customer_tax_ids: null }))).toEqual(["identification number"]);
		expect(missingRecipientDetails(source({ customer_tax_ids: [] }))).toEqual(["identification number"]);
		expect(
			missingRecipientDetails(source({ customer_tax_ids: [{ type: "bg_uic", value: "208913663" }] })),
		).toEqual([]);
	});

	it("names every gap at once, the state the first invoice was in before EA-2", () => {
		expect(
			missingRecipientDetails(source({ customer_name: null, customer_address: null, customer_tax_ids: null })),
		).toEqual(["name", "address", "identification number"]);
	});
});

describe("requestFactura", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		process.env.ODOO_INVOICE_URL = "https://odoo.test/alethia/invoice/issue";
		process.env.ODOO_INVOICE_TOKEN = "token-x";
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		delete process.env.ODOO_INVOICE_URL;
		delete process.env.ODOO_INVOICE_TOKEN;
	});

	it("returns the compliant фактура: ten-digit number, the ground, the PDF", async () => {
		answerWith(odooAnswer());
		const outcome = await requestFactura(source(), UNREGISTERED);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.factura.number).toBe("0000000042");
		expect(outcome.factura.vatGround).toBe(NO_VAT_GROUND_UNREGISTERED);
		expect(outcome.factura.currency).toBe("usd");
		expect(Buffer.from(outcome.factura.pdf).toString()).toBe("%PDF-фактура");
	});

	it("sends the invoice and the cell's ground, authenticated", async () => {
		answerWith(odooAnswer());
		await requestFactura(source(), UNREGISTERED);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://odoo.test/alethia/invoice/issue");
		expect(init.headers.Authorization).toBe("Bearer token-x");
		const sent = JSON.parse(init.body);
		expect(sent.vat_ground).toBe("чл. 113, ал. 9 ЗДДС");
		expect(sent.invoice.id).toBe("in_1");
	});

	it("accepts the ground with different spacing", async () => {
		answerWith(odooAnswer({ vat_ground: "  чл. 113,   ал. 9  ЗДДС " }));
		expect(await reasonOf(source())).toBe("ok");
	});

	it("is unconfigured, without a request, when either variable is missing", async () => {
		delete process.env.ODOO_INVOICE_TOKEN;
		expect(await reasonOf(source())).toBe("unconfigured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses an invoice with no id, without a request", async () => {
		expect(await reasonOf(source({ id: undefined }))).toBe("no_invoice_id");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses an incomplete recipient before asking Odoo, so no number is burned", async () => {
		const outcome = await requestFactura(source({ customer_address: null, customer_tax_ids: [] }), UNREGISTERED);
		expect(outcome).toEqual({
			ok: false,
			reason: "recipient_incomplete",
			detail: "the recipient's address, identification number are missing (Art. 114(1))",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses to guess a ground for a registered supplier", async () => {
		expect(await reasonOf(source(), REGISTERED)).toBe("no_ground_ruling");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is unreachable on a non-2xx answer", async () => {
		answerWith({ ok: false, error: "build_failed" }, 500);
		const outcome = await requestFactura(source(), UNREGISTERED);
		expect(outcome).toEqual({ ok: false, reason: "unreachable", detail: "Odoo answered HTTP 500" });
	});

	it("is unreachable when the request throws", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		const outcome = await requestFactura(source(), UNREGISTERED);
		expect(outcome).toEqual({ ok: false, reason: "unreachable", detail: "Odoo could not be reached" });
	});

	it("is unreachable, and says so, when Odoo does not answer in time", async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementationOnce(
			(_url: string, init: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		const pending = requestFactura(source(), UNREGISTERED);
		await vi.advanceTimersByTimeAsync(12_000);
		expect(await pending).toEqual({
			ok: false,
			reason: "unreachable",
			detail: "Odoo did not answer within 12s",
		});
	});

	it("is rejected when Odoo says it did not issue, sends no PDF, or sends another shape", async () => {
		answerWith(odooAnswer({ ok: false }));
		expect(await reasonOf(source())).toBe("rejected");
		answerWith(odooAnswer({ pdf_base64: undefined }));
		expect(await reasonOf(source())).toBe("rejected");
		answerWith(["not", "an", "object"]);
		expect(await reasonOf(source())).toBe("rejected");
	});

	it("refuses a draft, which has no legal number", async () => {
		answerWith(odooAnswer({ state: "draft", number: "/" }));
		expect(await reasonOf(source())).toBe("not_posted");
		answerWith(odooAnswer({ state: undefined }));
		expect(await reasonOf(source())).toBe("not_posted");
	});

	it("refuses Odoo's default INV/2026/00001 numbering", async () => {
		answerWith(odooAnswer({ number: "INV/2026/00001" }));
		const outcome = await requestFactura(source(), UNREGISTERED);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("number_format");
		expect(outcome.detail).toContain("INV/2026/00001");
	});

	it("refuses a posted фактура with no number", async () => {
		answerWith(odooAnswer({ number: null }));
		expect(await reasonOf(source())).toBe("number_format");
	});

	it("refuses a фактура that states no ground, or another one", async () => {
		answerWith(odooAnswer({ vat_ground: undefined }));
		expect(await reasonOf(source())).toBe("ground_mismatch");
		answerWith(odooAnswer({ vat_ground: "чл. 86, ал. 3 ЗДДС" }));
		expect(await reasonOf(source())).toBe("ground_mismatch");
	});

	it("shares one request between concurrent callers for the same invoice", async () => {
		answerWith(odooAnswer());
		const [a, b] = await Promise.all([
			requestFactura(source(), UNREGISTERED),
			requestFactura(source(), UNREGISTERED),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});
});

describe("issueFactura", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		process.env.ODOO_INVOICE_URL = "https://odoo.test/alethia/invoice/issue";
		process.env.ODOO_INVOICE_TOKEN = "token-x";
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.ODOO_INVOICE_URL;
		delete process.env.ODOO_INVOICE_TOKEN;
	});

	it("returns the фактура when it is compliant", async () => {
		answerWith(odooAnswer());
		expect((await issueFactura(source()))?.number).toBe("0000000042");
	});

	it("returns null, never a Stripe document, when it is not", async () => {
		answerWith(odooAnswer({ number: "INV/2026/00001" }));
		expect(await issueFactura(source())).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
