// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7369: one pass of the фактура sweeper. An owed фактура that now issues is written onto its mirror
// row; one that still fails pages the operator only from day 3 of the Art. 113(4) window, once per
// claim; a Stripe read that throws is a failure, not a crash; a PDF-less credit note is rendered.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));

import type { FacturaOutcome } from "@/lib/billing/factura/issue";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import {
	type InvoiceReader,
	type IssuedDocument,
	type PendingInvoice,
	runFacturaSweep,
	type SweepDeps,
	type SweepStore,
} from "@/lib/billing/factura/sweeper";
import type { Factura } from "@/lib/db/schema";
import { paidInvoice } from "./fixtures";

const NOW = new Date(Date.UTC(2027, 0, 20, 12, 0, 0));
const DAY = 24 * 60 * 60 * 1000;

/** A pending mirror row paid `daysAgo` days before NOW. */
function pending(id: string, daysAgo: number): PendingInvoice {
	return {
		id,
		organizationId: "org_1",
		stripeInvoiceId: `in_${id}`,
		stripeCustomerId: "cus_1",
		paidAt: new Date(NOW.getTime() - daysAgo * DAY),
	};
}

/** A store over `rows`, recording what was marked and claimed; a claim succeeds once per row. */
function store(rows: PendingInvoice[], notes: Factura[] = []): SweepStore & {
	marked: Map<string, IssuedDocument>;
	claims: string[];
} {
	const marked = new Map<string, IssuedDocument>();
	const claims: string[] = [];
	return {
		marked,
		claims,
		async pendingInvoices() {
			return rows.filter((r) => !marked.has(r.id));
		},
		async markIssued(id, doc) {
			marked.set(id, doc);
		},
		async claimAlert(id) {
			if (claims.includes(id)) return false;
			claims.push(id);
			return true;
		},
		async creditNotesWithoutPdf() {
			return notes;
		},
	};
}

/** A Stripe double whose `invoices.retrieve` returns the fixture invoice, or throws for `failing`. */
function stripe(failing: ReadonlySet<string> = new Set()): InvoiceReader {
	return {
		invoices: {
			retrieve: vi.fn(async (id: string) => {
				if (failing.has(id)) throw new Error("stripe 500");
				return { ...paidInvoice({ id }), hosted_invoice_url: `https://pay/${id}` };
			}),
		},
	};
}

/** A credit note with no PDF attached. */
function pdfLessNote(): Factura {
	return {
		id: "f9",
		organizationId: "org_1",
		number: "0000000009",
		kind: "credit_note",
		originalFacturaId: "f1",
		stripeInvoiceId: "in_a",
		stripeRefundId: "re_1",
		issueDate: "2027-01-19",
		chargeableDate: "2027-01-19",
		snapshot: buildFacturaSnapshot(paidInvoice(), {
			number: "0000000009",
			issueDate: "2027-01-19",
			chargeableDate: "2027-01-19",
			noVatGround: "чл. 113, ал. 9 ЗДДС",
			eurRate: null,
		}),
		pdfKey: null,
		pdfSha256: null,
		createdAt: new Date(NOW.getTime() - DAY),
	};
}

const ISSUED: FacturaOutcome = {
	ok: true,
	factura: { number: "0000000007", currency: "eur", vatGround: "чл. 113, ал. 9 ЗДДС", pdfKey: "org_1/in_a.pdf", pdf: new Uint8Array() },
};
const NO_RATE: FacturaOutcome = { ok: false, reason: "no_rate", detail: "no ECB rate" };

describe("runFacturaSweep", () => {
	it("writes a фактура that now issues onto its mirror row, and pages nobody", async () => {
		const s = store([pending("a", 4)]);
		const alert = vi.fn(async () => true);
		const report = await runFacturaSweep(NOW, { store: s, stripe: stripe(), request: async () => ISSUED, alert });
		expect(s.marked.get("a")).toEqual({ number: "0000000007", pdfKey: "org_1/in_a.pdf", hostedInvoiceUrl: "https://pay/in_a" });
		expect(report).toMatchObject({ retried: 1, issued: 1, alerted: 0, failures: 0 });
		expect(alert).not.toHaveBeenCalled();
	});

	it("pages for a фактура still owed on day 3, not on day 2, and names the deadline", async () => {
		const s = store([pending("young", 2), pending("old", 3.5)]);
		const alert = vi.fn(async () => true);
		const report = await runFacturaSweep(NOW, { store: s, stripe: stripe(), request: async () => NO_RATE, alert });
		expect(report).toMatchObject({ retried: 2, issued: 0, alerted: 1, failures: 2 });
		expect(s.claims).toEqual(["old"]);
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({ summary: expect.stringContaining("Art. 113(4) ЗДДС deadline: 2027-01-22") }),
		);
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining("no_rate") }));
	});

	it("pages once when another pass already claimed the alert", async () => {
		const s = store([pending("old", 4)]);
		const alert = vi.fn(async () => true);
		await runFacturaSweep(NOW, { store: s, stripe: stripe(), request: async () => NO_RATE, alert });
		await runFacturaSweep(NOW, { store: s, stripe: stripe(), request: async () => NO_RATE, alert });
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("counts a Stripe read that throws as a failure and still checks the deadline", async () => {
		const s = store([pending("b", 4), pending("c", 1)]);
		const alert = vi.fn(async () => true);
		const request = vi.fn(async () => ISSUED);
		const report = await runFacturaSweep(NOW, { store: s, stripe: stripe(new Set(["in_b"])), request, alert });
		expect(report).toMatchObject({ retried: 2, issued: 1, alerted: 1, failures: 1 });
		expect(s.marked.has("c")).toBe(true);
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining("in_b") }));
	});

	it("renders the PDF of a credit note that has none", async () => {
		const document = vi.fn(async (): Promise<FacturaOutcome> => ISSUED);
		const report = await runFacturaSweep(NOW, {
			store: store([], [pdfLessNote()]),
			stripe: stripe(),
			request: async () => ISSUED,
			document,
			alert: vi.fn(async () => true),
		});
		expect(document).toHaveBeenCalledTimes(1);
		expect(report.pdfsRendered).toBe(1);
	});
});
