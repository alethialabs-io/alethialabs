// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// (node, not jsdom: the success path builds a `Response` from a `Blob`, and jsdom's Blob is not
// the one undici's `Response` can stream.)

// #6113 (ADR 0005 stress test R4): a route handler under `/{org}/` must answer a non-member with the
// same 404 as an unknown org — not 401 ("sign in"), which is what the invoice PDF route said.
//
// CON-L3 (R6 F-08): every failure is an HTML page, never JSON — both readers of this route (the
// preview iframe and a "Download PDF" navigation) render the body as it is.
//
// EA-7b (#7338): the route NEVER redirects to Stripe's hosted invoice. Only the stored фактура is
// the invoice; a row without one answers "being issued", and an unreadable stored copy answers 503.
// Every case below that could redirect carries a `hostedInvoiceUrl`, so a restored fallback fails.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { authorize, getOrgInvoice, storageGet } = vi.hoisted(() => ({
	authorize: vi.fn(),
	getOrgInvoice: vi.fn(),
	storageGet: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ authorize }));
vi.mock("@/lib/billing/invoices", () => ({ getOrgInvoice }));
vi.mock("@/lib/storage", () => ({ storage: { get: storageGet } }));
vi.mock("@/lib/storage/invoice-pdf", () => ({ INVOICE_PDF_BUCKET: "invoices" }));

import { GET } from "@/app/(private)/[org]/~/settings/billing/invoices/[id]/pdf/route";
import { ForbiddenError } from "@/lib/authz/types";

const call = () => GET(new Request("http://console.test/acme/~/settings/billing/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });

beforeEach(() => {
	authorize.mockReset();
	getOrgInvoice.mockReset();
	getOrgInvoice.mockResolvedValue(null);
	storageGet.mockReset();
});

/** Asserts `res` is the HTML failure page, not JSON, and answers its body. */
async function htmlBody(res: Response): Promise<string> {
	expect(res.headers.get("content-type")).toMatch(/^text\/html/);
	const body = await res.text();
	expect(body).toMatch(/^<!doctype html>/);
	expect(body).not.toMatch(/"error"/);
	return body;
}

const invoice = (over: Record<string, unknown> = {}) => ({
	id: "inv-1",
	number: "A-0001",
	pdfKey: "org-1/inv-1.pdf",
	facturaStatus: "issued",
	hostedInvoiceUrl: "https://invoice.stripe.test/i/inv-1",
	...over,
});

describe("invoice PDF refusals", () => {
	it("answers a non-member of the addressed org with 404", async () => {
		authorize.mockRejectedValue(Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
		expect((await call()).status).toBe(404);
	});

	it("answers a member without billing permission with 403", async () => {
		authorize.mockRejectedValue(new ForbiddenError("manage_billing", { type: "billing" }));
		expect((await call()).status).toBe(403);
	});

	it("answers no session with 401", async () => {
		authorize.mockRejectedValue(new Error("Unauthorized"));
		expect((await call()).status).toBe(401);
	});

	it("answers each refusal as an HTML page with its sentence", async () => {
		authorize.mockRejectedValue(new ForbiddenError("manage_billing", { type: "billing" }));
		expect(await htmlBody(await call())).toContain("billing permission");

		authorize.mockRejectedValue(new Error("Unauthorized"));
		expect(await htmlBody(await call())).toContain("Your session has ended");

		authorize.mockResolvedValue({ orgId: "org-1" });
		const missing = await call();
		expect(missing.status).toBe(404);
		expect(await htmlBody(missing)).toContain("Invoice not found");
	});

	it("serves the stored PDF when it can be read", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice());
		storageGet.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
		const res = await call();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
	});

	it("never redirects to the hosted invoice when the stored copy cannot be read", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice());
		storageGet.mockRejectedValue(new Error("bucket unreachable"));
		const res = await call();
		expect(res.status).toBe(503);
		expect(res.headers.get("location")).toBeNull();
		expect(await htmlBody(res)).toContain("Couldn't load this invoice");
	});

	it("answers a stored key whose object is missing as a 503 page, not the hosted invoice", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice());
		storageGet.mockResolvedValue(null);
		const res = await call();
		expect(res.status).toBe(503);
		expect(res.headers.get("location")).toBeNull();
	});

	it("answers an unreadable stored copy with no hosted invoice as a 503 page", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice({ hostedInvoiceUrl: null }));
		storageGet.mockRejectedValue(new Error("bucket unreachable"));
		const res = await call();
		expect(res.status).toBe(503);
		expect(await htmlBody(res)).toContain("Couldn't load this invoice");
	});

	it("answers an invoice with no stored фактура as 'being issued', even when Stripe has a hosted invoice", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice({ pdfKey: null, number: null }));
		const res = await call();
		expect(res.status).toBe(404);
		expect(res.headers.get("location")).toBeNull();
		const body = await htmlBody(res);
		expect(body).toContain("Your invoice is being issued");
		expect(body).toContain('data-invoice-pdf-error="being-issued"');
		expect(body).not.toContain("stripe");
		expect(storageGet).not.toHaveBeenCalled();
	});

	it("never serves a stored PDF on a row whose фактура is not issued (a pre-pipeline Stripe copy)", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		for (const facturaStatus of ["pending", "failed", null]) {
			getOrgInvoice.mockResolvedValue(invoice({ facturaStatus }));
			const res = await call();
			expect(res.status).toBe(404);
			expect(await htmlBody(res)).toContain("Your invoice is being issued");
		}
		expect(storageGet).not.toHaveBeenCalled();
	});

	it("answers an invoice with no document anywhere as 'being issued'", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockResolvedValue(invoice({ pdfKey: null, hostedInvoiceUrl: null }));
		const res = await call();
		expect(res.status).toBe(404);
		expect(await htmlBody(res)).toContain("Your invoice is being issued");
	});

	it("answers a failed invoice read as a 503 page, not an unhandled error", async () => {
		authorize.mockResolvedValue({ orgId: "org-1" });
		getOrgInvoice.mockRejectedValue(new Error("db down"));
		const res = await call();
		expect(res.status).toBe(503);
		await htmlBody(res);
	});
});
