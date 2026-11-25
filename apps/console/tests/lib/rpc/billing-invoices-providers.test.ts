// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The invoices read per provider (L5, lib/rpc/procedures/billing.ts `listInvoices`): a Stripe-era
// org reads the local mirror exactly as before; a Paddle customer also sees Paddle's invoices
// (Paddle is the merchant of record), merged newest first, through the same filters and limit, and
// in the same row shape — so the invoices UI renders them unchanged.

import { money } from "@repo/format";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { authorizeRead, listOrgInvoices, providerDocumentsForOrg } = vi.hoisted(() => ({
	authorizeRead: vi.fn(async () => ({ orgId: "org-1" })),
	listOrgInvoices: vi.fn(),
	providerDocumentsForOrg: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeRead, authorizeQuiet: vi.fn(), currentActor: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({ listOrgInvoices }));
vi.mock("@/lib/billing/provider/documents", () => ({ providerDocumentsForOrg }));

import { documentToInvoiceInfo, listInvoices } from "@/lib/rpc/procedures/billing";
import type { BillingDocument } from "@/lib/billing/provider/types";

/** A mirrored Stripe-era invoice row with an issued фактура. */
function mirrored(id: string, paidAt: string) {
	return {
		id,
		number: `F-${id}`,
		amountTotal: 2000,
		currency: "usd",
		status: "paid",
		paidAt: new Date(paidAt),
		createdAt: new Date(paidAt),
		periodStart: null,
		periodEnd: null,
		description: "Pro",
		facturaStatus: "issued",
		pdfKey: `k/${id}.pdf`,
	};
}

/** A Paddle document. */
function paddleDoc(id: string, issuedAt: string, number: string | null = `P-${id}`): BillingDocument {
	return {
		id,
		kind: "invoice",
		number,
		issuedAt: new Date(issuedAt),
		total: money(2178, "EUR"),
		url: null,
		issuer: "paddle",
		periodStart: new Date("2026-11-01T00:00:00Z"),
		periodEnd: new Date("2026-12-01T00:00:00Z"),
	};
}

beforeEach(() => {
	listOrgInvoices.mockReset();
	providerDocumentsForOrg.mockReset();
	providerDocumentsForOrg.mockResolvedValue([]);
});

describe("listInvoices per provider", () => {
	it("a Stripe-era org reads only the mirror, unchanged", async () => {
		listOrgInvoices.mockResolvedValue([mirrored("inv-1", "2026-10-01T00:00:00Z")]);
		const rows = await listInvoices();
		expect(rows).toEqual([
			{
				id: "inv-1",
				number: "F-inv-1",
				total: 2000,
				currency: "usd",
				status: "paid",
				paidAt: "2026-10-01T00:00:00.000Z",
				periodStart: null,
				periodEnd: null,
				description: "Pro",
				facturaIssued: true,
			},
		]);
		expect(providerDocumentsForOrg).toHaveBeenCalledWith("org-1", { limit: 200 });
	});

	it("a Paddle customer also sees Paddle's invoices, merged newest first", async () => {
		listOrgInvoices.mockResolvedValue([mirrored("inv-1", "2026-10-01T00:00:00Z")]);
		providerDocumentsForOrg.mockResolvedValue([paddleDoc("txn_b", "2026-11-20T00:00:00Z"), paddleDoc("txn_a", "2026-09-01T00:00:00Z")]);
		const rows = await listInvoices();
		expect(rows.map((r) => r.id)).toEqual(["txn_b", "inv-1", "txn_a"]);
		expect(rows[0]).toMatchObject({ number: "P-txn_b", total: 2178, currency: "eur", status: "paid", facturaIssued: true });
	});

	it("applies the status, date and limit filters to Paddle's rows too", async () => {
		listOrgInvoices.mockResolvedValue([]);
		providerDocumentsForOrg.mockResolvedValue([paddleDoc("txn_new", "2026-11-20T00:00:00Z"), paddleDoc("txn_old", "2026-01-01T00:00:00Z")]);
		expect((await listInvoices({ paidFrom: "2026-06-01T00:00:00.000Z" })).map((r) => r.id)).toEqual(["txn_new"]);
		expect((await listInvoices({ paidTo: "2026-06-01T00:00:00.000Z" })).map((r) => r.id)).toEqual(["txn_old"]);
		expect(await listInvoices({ status: ["refunded"] })).toEqual([]);
		expect((await listInvoices({ limit: 1 })).map((r) => r.id)).toEqual(["txn_new"]);
	});

	it("propagates a Paddle failure instead of showing an incomplete list", async () => {
		listOrgInvoices.mockResolvedValue([]);
		providerDocumentsForOrg.mockRejectedValue(new Error("paddle down"));
		await expect(listInvoices()).rejects.toThrow("paddle down");
	});
});

describe("documentToInvoiceInfo", () => {
	it("is not downloadable until Paddle has numbered the invoice", () => {
		expect(documentToInvoiceInfo(paddleDoc("txn_x", "2026-11-01T00:00:00Z", null))).toMatchObject({ number: null, facturaIssued: false });
	});
});
