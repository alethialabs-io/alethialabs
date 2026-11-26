// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The paged invoices read (lib/rpc/procedures/billing.ts `readInvoicesPage`, LST-11 #7493) over both
// sources `queryInvoicesPage` returns: a Stripe-era mirrored invoice keeps its own id and фактура
// rule, and a mirrored Paddle invoice (Paddle is the merchant of record) is listed under PADDLE's
// transaction id — the key the PDF route answers with Paddle's own PDF — never under the mirror's
// row uuid, which only orders the list.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { authorizeRead, queryInvoicesPage } = vi.hoisted(() => ({
	authorizeRead: vi.fn(async () => ({ orgId: "org-1" })),
	queryInvoicesPage: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeRead, authorizeQuiet: vi.fn(), currentActor: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/queries/billing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/queries/billing")>()),
	queryInvoicesPage,
}));

import type { PaddleTransaction } from "@/lib/db/schema";
import { paddleTransactionToInvoiceInfo, readInvoicesPage } from "@/lib/rpc/procedures/billing";

const PADDLE: PaddleTransaction = {
	id: "00000000-0000-4000-8000-000000000002",
	organizationId: "org-1",
	paddleTransactionId: "txn_01abc",
	paddleSubscriptionId: "sub_01",
	paddleCustomerId: "ctm_01",
	status: "completed",
	origin: "subscription_recurring",
	currency: "EUR",
	subtotalMinor: 1800,
	taxMinor: 378,
	totalMinor: 2178,
	invoiceNumber: "325-10001",
	billingPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
	billingPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
	billedAt: new Date("2026-11-01T00:00:05.000Z"),
	refundedAt: null,
	chargebackAt: null,
	customData: null,
	eventOccurredAt: null,
	createdAt: new Date("2026-11-01T00:00:06.000Z"),
	updatedAt: new Date("2026-11-01T00:00:06.000Z"),
};

const LOCAL = {
	id: "00000000-0000-4000-8000-000000000001",
	organizationId: "org-1",
	number: "F-1",
	amountTotal: 2000,
	currency: "usd",
	status: "paid",
	paidAt: new Date("2026-10-01T00:00:00.000Z"),
	createdAt: new Date("2026-10-01T00:00:00.000Z"),
	periodStart: null,
	periodEnd: null,
	description: "Pro",
	facturaStatus: "issued",
	pdfKey: "k/1.pdf",
};

beforeEach(() => {
	queryInvoicesPage.mockReset();
});

describe("readInvoicesPage — both sources in one page", () => {
	it("maps each row by its source and keeps the page's cursor and facets", async () => {
		const facets = { status: [{ value: "paid", label: null, count: 2 }] };
		queryInvoicesPage.mockResolvedValue({
			rows: [
				{ source: "paddle", transaction: PADDLE },
				{ source: "invoice", invoice: LOCAL },
			],
			nextCursor: "c",
			facets,
			universeEmpty: false,
		});
		const page = await readInvoicesPage({ status: ["paid"] }, { limit: 2 });
		expect(queryInvoicesPage).toHaveBeenCalledWith("org-1", expect.objectContaining({ status: ["paid"] }), { limit: 2 });
		expect(page.rows.map((r) => r.id)).toEqual(["txn_01abc", LOCAL.id]);
		expect(page.rows[1]).toMatchObject({ number: "F-1", facturaIssued: true, currency: "usd" });
		expect(page).toMatchObject({ nextCursor: "c", facets, universeEmpty: false });
	});
});

describe("paddleTransactionToInvoiceInfo", () => {
	it("is Paddle's transaction id, number, total, billed instant and period", () => {
		expect(paddleTransactionToInvoiceInfo(PADDLE)).toEqual({
			id: "txn_01abc",
			number: "325-10001",
			total: 2178,
			currency: "eur",
			status: "paid",
			paidAt: "2026-11-01T00:00:05.000Z",
			periodStart: "2026-11-01T00:00:00.000Z",
			periodEnd: "2026-12-01T00:00:00.000Z",
			description: null,
			facturaIssued: true,
		});
	});

	it("is not downloadable until Paddle has numbered it, and reads refunded after a refund", () => {
		expect(paddleTransactionToInvoiceInfo({ ...PADDLE, invoiceNumber: null })).toMatchObject({ number: null, facturaIssued: false });
		expect(paddleTransactionToInvoiceInfo({ ...PADDLE, refundedAt: new Date() }).status).toBe("refunded");
		// A billed-but-unpaid invoice is due, not paid; a past-due one is overdue.
		expect(paddleTransactionToInvoiceInfo({ ...PADDLE, status: "billed" }).status).toBe("open");
		expect(paddleTransactionToInvoiceInfo({ ...PADDLE, status: "past_due" }).status).toBe("overdue");
	});
});
