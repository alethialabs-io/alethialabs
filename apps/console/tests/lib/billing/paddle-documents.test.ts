// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle invoices (lib/billing/paddle/documents.ts + lib/billing/provider/documents.ts): the list is
// parsed, paginated with Paddle's `after` cursor, and kept to the ORG's own transactions — a Paddle
// customer can span several orgs, so `customer_id` alone is never trusted. The PDF lookup applies the
// same ownership test before it asks Paddle for a URL. A routing fetch stub stands in for Paddle.

import { money } from "@repo/format";
import { describe, expect, it, vi } from "vitest";
import { createPaddleClient } from "@/lib/billing/paddle/api";
import {
	listPaddleDocuments,
	type OrgPaddleOwnership,
	ownsTransaction,
	PADDLE_TRANSACTIONS_PAGE_SIZE,
	type PaddleDocumentDeps,
	paddleInvoicePdfUrl,
	toBillingDocument,
} from "@/lib/billing/paddle/documents";
import { providerDocumentsForOrg } from "@/lib/billing/provider/documents";
import type { BillingDocument, BillingProvider } from "@/lib/billing/provider/types";

const KEY = `pdl_sdbx_apikey_${"c".repeat(20)}`;
const ORG = "11111111-1111-4111-8111-111111111111";

/** A transaction as Paddle lists it. */
function txn(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		status: "completed",
		subscription_id: "sub_mine",
		customer_id: "ctm_1",
		invoice_number: `INV-${id}`,
		currency_code: "EUR",
		billed_at: "2026-11-01T10:00:00Z",
		billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
		custom_data: null,
		details: { totals: { total: "2178" } },
		...over,
	};
}

const OWN: OrgPaddleOwnership = {
	organizationId: ORG,
	customerId: "ctm_1",
	subscriptionIds: new Set(["sub_mine"]),
	mirroredTransactionIds: new Set(["txn_pack"]),
};

/** Deps over a fetch stub `f` and an ownership record. */
function deps(f: typeof fetch, own: OrgPaddleOwnership = OWN): PaddleDocumentDeps {
	return {
		client: () => createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f }),
		ownership: async () => own,
	};
}

/** A fetch stub answering `GET /transactions` pages by their `after` cursor. */
function pages(byAfter: Record<string, unknown[]>) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = new URL(String(input));
		const page = byAfter[url.searchParams.get("after") ?? ""] ?? [];
		return new Response(JSON.stringify({ data: page }), { status: 200 });
	});
}

describe("ownsTransaction", () => {
	it("owns its subscriptions, its mirrored transactions and its own checkouts — nothing else", () => {
		const parse = (o: Record<string, unknown>) => ({ ...txn("txn_x"), ...o, billed_at: null, billing_period: null, details: { totals: { total: 0 } } });
		expect(ownsTransaction(OWN, parse({ subscription_id: "sub_mine" }))).toBe(true);
		expect(ownsTransaction(OWN, parse({ id: "txn_pack", subscription_id: null }))).toBe(true);
		expect(ownsTransaction(OWN, parse({ subscription_id: null, custom_data: { organizationId: ORG, kind: "plan" } }))).toBe(true);
		expect(ownsTransaction(OWN, parse({ subscription_id: "sub_theirs" }))).toBe(false);
		expect(ownsTransaction(OWN, parse({ subscription_id: null, custom_data: { organizationId: "other-org" } }))).toBe(false);
		expect(ownsTransaction(OWN, parse({ subscription_id: null, custom_data: "garbage" }))).toBe(false);
		// custom_data naming the org counts only on the org's own Paddle customer.
		expect(ownsTransaction(OWN, parse({ subscription_id: null, customer_id: "ctm_other", custom_data: { organizationId: ORG } }))).toBe(false);
	});
});

describe("listPaddleDocuments", () => {
	it("parses Paddle's transactions into documents issued by Paddle", async () => {
		const f = pages({ "": [txn("txn_a")] });
		const docs = await listPaddleDocuments(ORG, {}, deps(f));
		expect(docs).toEqual<BillingDocument[]>([
			{
				id: "txn_a",
				kind: "invoice",
				number: "INV-txn_a",
				issuedAt: new Date("2026-11-01T10:00:00Z"),
				total: money(2178, "eur"),
				url: null,
				issuer: "paddle",
				periodStart: new Date("2026-11-01T00:00:00Z"),
				periodEnd: new Date("2026-12-01T00:00:00Z"),
			},
		]);
		const url = new URL(String(f.mock.calls[0][0]));
		expect(url.pathname).toBe("/transactions");
		expect(url.searchParams.get("customer_id")).toBe("ctm_1");
		expect(url.searchParams.get("status")).toBe("billed,completed");
		expect(url.searchParams.has("after")).toBe(false);
	});

	it("drops another org's transactions under the same Paddle customer", async () => {
		const f = pages({ "": [txn("txn_a"), txn("txn_theirs", { subscription_id: "sub_theirs" }), txn("txn_pack", { subscription_id: null })] });
		const docs = await listPaddleDocuments(ORG, {}, deps(f));
		expect(docs.map((d) => d.id)).toEqual(["txn_a", "txn_pack"]);
	});

	it("follows the `after` cursor across full pages and stops at a short one", async () => {
		const full = Array.from({ length: PADDLE_TRANSACTIONS_PAGE_SIZE }, (_, i) => txn(`txn_p1x${i}`));
		const f = pages({ "": full, [`txn_p1x${PADDLE_TRANSACTIONS_PAGE_SIZE - 1}`]: [txn("txn_p2")] });
		const docs = await listPaddleDocuments(ORG, { limit: 200 }, deps(f));
		expect(docs).toHaveLength(PADDLE_TRANSACTIONS_PAGE_SIZE + 1);
		expect(f).toHaveBeenCalledTimes(2);
		expect(new URL(String(f.mock.calls[1][0])).searchParams.get("after")).toBe(`txn_p1x${PADDLE_TRANSACTIONS_PAGE_SIZE - 1}`);
	});

	it("stops at the limit without reading further pages", async () => {
		const full = Array.from({ length: PADDLE_TRANSACTIONS_PAGE_SIZE }, (_, i) => txn(`txn_${i}`));
		const f = pages({ "": full });
		const docs = await listPaddleDocuments(ORG, { limit: 5 }, deps(f));
		expect(docs).toHaveLength(5);
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("is empty with no Paddle call for an org without a Paddle customer", async () => {
		const f = pages({});
		expect(await listPaddleDocuments(ORG, {}, deps(f, { ...OWN, customerId: null }))).toEqual([]);
		expect(f).not.toHaveBeenCalled();
	});

	it("throws on a response it cannot parse rather than returning a partial list", async () => {
		const f = pages({ "": [{ id: "txn_bad", status: "completed" }] });
		await expect(listPaddleDocuments(ORG, {}, deps(f))).rejects.toThrow(/expected shape/);
	});

	it("builds a document with null number and period when Paddle has none", () => {
		const doc = toBillingDocument({ ...txn("txn_n"), invoice_number: null, billed_at: null, billing_period: null, details: { totals: { total: 0 } } });
		expect(doc).toMatchObject({ number: null, issuedAt: null, periodStart: null, periodEnd: null });
	});
});

describe("paddleInvoicePdfUrl", () => {
	/** A stub answering the transaction and its invoice. */
	function invoiceRoutes(t: Record<string, unknown>, status = 200) {
		return vi.fn<typeof fetch>(async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/invoice")) {
				return new Response(JSON.stringify({ data: { url: `https://paddle.test/pdf?d=${url.searchParams.get("disposition")}` } }), { status: 200 });
			}
			if (status !== 200) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status });
			return new Response(JSON.stringify({ data: t }), { status: 200 });
		});
	}

	it("returns Paddle's URL for the org's own billed transaction", async () => {
		const f = invoiceRoutes(txn("txn_a"));
		await expect(paddleInvoicePdfUrl(ORG, "txn_a", "attachment", deps(f))).resolves.toBe("https://paddle.test/pdf?d=attachment");
	});

	it("is null — and never asks for the invoice — for another org's transaction", async () => {
		const f = invoiceRoutes(txn("txn_t", { subscription_id: "sub_theirs" }));
		await expect(paddleInvoicePdfUrl(ORG, "txn_t", "inline", deps(f))).resolves.toBeNull();
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("is null for a transaction not billed yet, a 404, or an id that is not a transaction id", async () => {
		await expect(paddleInvoicePdfUrl(ORG, "txn_a", "inline", deps(invoiceRoutes(txn("txn_a", { status: "ready" }))))).resolves.toBeNull();
		await expect(paddleInvoicePdfUrl(ORG, "txn_a", "inline", deps(invoiceRoutes({}, 404)))).resolves.toBeNull();
		const f = invoiceRoutes(txn("txn_a"));
		await expect(paddleInvoicePdfUrl(ORG, "../etc", "inline", deps(f))).resolves.toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it("refuses a non-https invoice URL", async () => {
		const f = vi.fn<typeof fetch>(async (input) =>
			String(input).includes("/invoice")
				? new Response(JSON.stringify({ data: { url: "javascript:alert(1)" } }), { status: 200 })
				: new Response(JSON.stringify({ data: txn("txn_a") }), { status: 200 }),
		);
		await expect(paddleInvoicePdfUrl(ORG, "txn_a", "inline", deps(f))).rejects.toThrow(/expected shape/);
	});

	it("throws on a Paddle server error", async () => {
		await expect(paddleInvoicePdfUrl(ORG, "txn_a", "inline", deps(invoiceRoutes({}, 500)))).rejects.toThrow(/500/);
	});
});

describe("providerDocumentsForOrg", () => {
	/** A provider stub whose listDocuments answers `docs`. */
	function paddle(configured: boolean, docs: BillingDocument[] = []) {
		const listDocuments = vi.fn(async () => docs);
		const p: Pick<BillingProvider, "isConfigured" | "listDocuments"> = { isConfigured: () => configured, listDocuments };
		return { p, listDocuments };
	}

	it("lists Paddle documents for an org with a Paddle customer", async () => {
		const doc = toBillingDocument({ ...txn("txn_a"), billed_at: null, billing_period: null, details: { totals: { total: 5 } } });
		const { p, listDocuments } = paddle(true, [doc]);
		const out = await providerDocumentsForOrg(ORG, { limit: 10 }, {
			paddleCustomerId: async () => "ctm_1",
			provider: () => ({ ...createStub(), ...p }),
		});
		expect(out).toEqual([doc]);
		expect(listDocuments).toHaveBeenCalledWith(ORG, { limit: 10 });
	});

	it("asks nothing of Paddle without a Paddle customer, or when Paddle is not configured", async () => {
		const a = paddle(true);
		expect(await providerDocumentsForOrg(ORG, {}, { paddleCustomerId: async () => null, provider: () => ({ ...createStub(), ...a.p }) })).toEqual([]);
		expect(a.listDocuments).not.toHaveBeenCalled();
		const b = paddle(false);
		const lookup = vi.fn(async () => "ctm_1");
		expect(await providerDocumentsForOrg(ORG, {}, { paddleCustomerId: lookup, provider: () => ({ ...createStub(), ...b.p }) })).toEqual([]);
		expect(lookup).not.toHaveBeenCalled();
	});
});

/** A full provider whose every method refuses — the tests above override the two they use. */
function createStub(): BillingProvider {
	const no = () => Promise.reject(new Error("unused"));
	return {
		id: "paddle",
		sellerOfRecord: "paddle",
		isConfigured: () => false,
		mode: () => null,
		startPurchase: no,
		managementUrl: no,
		cancelAtPeriodEnd: no,
		resume: no,
		changePlan: no,
		postUsageCharge: no,
		reportJobUsage: () => Promise.resolve(false),
		listDocuments: no,
		livePrices: no,
		parseWebhook: no,
	};
}
