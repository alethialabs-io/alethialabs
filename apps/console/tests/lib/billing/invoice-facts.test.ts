// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-invoice tax facts and the turnover alerts (#7327, EA-5), over an in-memory store that keeps
// invoice rows the way the `invoice` table does. The aggregation rules themselves are
// packages/legal/src/turnover.test.ts's subject; this file pins what the console does with them:
// the snapshot is the declaration AT PAYMENT and is written once, the EUR amount carries its rate and
// source, alerts fire once per rise and are keyed on the threshold, and refunds leave the totals.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));
vi.mock("@/lib/billing/invoices", () => ({ setInvoiceStatus: vi.fn() }));

import { alertOperator } from "@/lib/billing/operator-alert";
import { setInvoiceStatus } from "@/lib/billing/invoices";
import {
	assessSaleBeforeCharge,
	type InvoiceFactRow,
	type InvoiceFactsStore,
	type InvoiceSnapshotPatch,
	markRefundedInvoice,
	type PayerDeclaration,
	readTurnoverTotals,
	recordInvoiceFacts,
} from "@/lib/billing/invoice-facts";
import { ecbRateFromXml, type EurRateLookup, toEurMinor } from "@/lib/billing/ecb-rate";

const NOW = new Date("2027-06-15T12:00:00Z");
const PAID_AT = Math.floor(new Date("2027-06-15T11:00:00Z").getTime() / 1000);

/** An in-memory `invoice` table and `organization_billing` declarations. */
function memoryStore(declarations: Record<string, PayerDeclaration> = {}) {
	const rows = new Map<string, InvoiceFactRow & { stripeInvoiceId: string }>();
	const writes: { id: string; patch: InvoiceSnapshotPatch }[] = [];
	const write = (id: string, patch: InvoiceSnapshotPatch) => {
		writes.push({ id, patch });
		for (const [key, row] of rows) {
			if (row.id !== id) continue;
			rows.set(key, {
				...row,
				country: patch.customerCountry !== undefined ? patch.customerCountry : row.country,
				state: patch.customerState !== undefined ? patch.customerState : row.state,
				capacity: patch.payerCapacity !== undefined ? patch.payerCapacity : row.capacity,
				vatIdGiven: patch.vatIdGiven !== undefined ? patch.vatIdGiven : row.vatIdGiven,
				amountEurMinor: patch.amountEurMinor ?? row.amountEurMinor,
				eurRateSource: patch.eurRateSource ?? row.eurRateSource,
			});
		}
	};
	const since = (from: Date) =>
		[...rows.values()].filter((r) => r.paidAt !== null && r.paidAt >= from);
	const store: InvoiceFactsStore = {
		declaration: async (orgId) => declarations[orgId] ?? null,
		locked: async (fn) =>
			fn({
				invoiceRow: async (id) => rows.get(id) ?? null,
				factsSince: async (from) => since(from),
				writeSnapshot: async (id, patch) => write(id, patch),
			}),
		factsSince: async (from) => since(from),
	};
	/** Mirrors a paid invoice row with no facts, as `mirrorPaidInvoice` leaves it. */
	const mirror = (stripeInvoiceId: string, over: Partial<InvoiceFactRow> = {}) => {
		rows.set(stripeInvoiceId, {
			id: `row_${stripeInvoiceId}`,
			stripeInvoiceId,
			status: "paid",
			paidAt: new Date(PAID_AT * 1000),
			currency: "eur",
			amountMinor: 100_00,
			amountEurMinor: null,
			country: null,
			state: null,
			capacity: null,
			vatIdGiven: null,
			eurRateSource: null,
			...over,
		});
	};
	return { store, rows, writes, mirror };
}

/** A Stripe invoice as the webhook receives it, with only the fields the recording reads. */
function stripeInvoice(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
	const base = {
		id: "in_1",
		currency: "eur",
		total: 100_00,
		total_excluding_tax: 100_00,
		status_transitions: { paid_at: PAID_AT, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
	};
	return { ...base, ...over } as unknown as Stripe.Invoice;
}

const ORG = "org_1";
const BG_ORG: PayerDeclaration = { country: "bg", state: null, capacity: "organization", vatIdStatus: "not_given" };
const ecbNever: EurRateLookup = async (currency) =>
	currency === "eur" ? { eurPerUnit: "1.00000000", source: "EUR" } : null;
const opts = (store: InvoiceFactsStore, eurRate: EurRateLookup = ecbNever) => ({
	store,
	eurRate,
	now: () => NOW,
});

beforeEach(() => {
	vi.mocked(alertOperator).mockClear();
	vi.mocked(setInvoiceStatus).mockClear();
});

describe("the EUR conversion", () => {
	const XML = `<?xml version="1.0"?><gesmes:Envelope><Cube>
		<Cube time="2027-06-15"><Cube currency="USD" rate="1.2000"/><Cube currency="JPY" rate="160.1"/></Cube>
		<Cube time="2027-06-14"><Cube currency="USD" rate="1.2500"/></Cube>
		<Cube time="2027-06-11"><Cube currency="USD" rate="1.1000"/></Cube>
	</Cube></gesmes:Envelope>`;

	it("takes the latest ECB publication on or before the payment date, inverted to EUR per unit", () => {
		expect(ecbRateFromXml(XML, "usd", new Date("2027-06-14T20:00:00Z"))).toEqual({
			eurPerUnit: "0.80000000",
			source: "ECB:2027-06-14",
		});
		// A weekend payment uses Friday's rate.
		expect(ecbRateFromXml(XML, "USD", new Date("2027-06-13T09:00:00Z"))?.source).toBe("ECB:2027-06-11");
	});

	it("is null for a currency or a date the file does not cover — never a guess", () => {
		expect(ecbRateFromXml(XML, "gbp", new Date("2027-06-15T12:00:00Z"))).toBeNull();
		expect(ecbRateFromXml(XML, "usd", new Date("2027-06-01T12:00:00Z"))).toBeNull();
	});

	it("converts with the STORED 8-place rate, so the row re-checks; EUR is exact", () => {
		expect(toEurMinor(12_345, "usd", { eurPerUnit: "0.80000000", source: "x" })).toBe(9_876);
		expect(toEurMinor(12_345, "eur", { eurPerUnit: "1.00000000", source: "EUR" })).toBe(12_345);
	});
});

describe("recordInvoiceFacts — the snapshot", () => {
	it("writes the buyer as declared at payment, normalised, with the EUR amount, rate and source", async () => {
		const { store, mirror, writes } = memoryStore({ [ORG]: BG_ORG });
		mirror("in_1");
		const res = await recordInvoiceFacts(stripeInvoice(), ORG, opts(store));
		expect(res).toMatchObject({ recorded: true, snapshot: true, eurConverted: true });
		expect(writes).toEqual([
			{
				id: "row_in_1",
				patch: {
					customerCountry: "BG",
					customerState: null,
					payerCapacity: "organization",
					vatIdGiven: false,
					amountEurMinor: 100_00,
					eurRate: "1.00000000",
					eurRateSource: "EUR",
				},
			},
		]);
	});

	it("keeps the US state, upper-cased, only for a US buyer", async () => {
		const { store, mirror, writes } = memoryStore({
			[ORG]: { country: "US", state: "ny", capacity: "consumer", vatIdStatus: null },
		});
		mirror("in_1", { currency: "usd" });
		await recordInvoiceFacts(stripeInvoice({ currency: "usd" }), ORG, opts(store));
		expect(writes[0]?.patch).toMatchObject({ customerCountry: "US", customerState: "NY", vatIdGiven: null });
	});

	it("is written ONCE: a replay after the declaration changed re-describes nothing", async () => {
		const declarations = { [ORG]: BG_ORG };
		const { store, mirror, writes } = memoryStore(declarations);
		mirror("in_1");
		await recordInvoiceFacts(stripeInvoice(), ORG, opts(store));
		declarations[ORG] = { country: "DE", state: null, capacity: "organization", vatIdStatus: "given" };
		const replay = await recordInvoiceFacts(stripeInvoice(), ORG, opts(store));
		expect(replay).toEqual({ recorded: false, reason: "already_recorded" });
		expect(writes).toHaveLength(1);
	});

	it("a replay fills a EUR amount that could not be converted the first time, and nothing else", async () => {
		const { store, mirror, writes } = memoryStore({
			[ORG]: { country: "DE", state: null, capacity: "consumer", vatIdStatus: null },
		});
		mirror("in_1", { currency: "usd" });
		const usd = stripeInvoice({ currency: "usd" });
		const first = await recordInvoiceFacts(usd, ORG, opts(store));
		expect(first).toMatchObject({ recorded: true, eurConverted: false });
		const ecbBack: EurRateLookup = async () => ({ eurPerUnit: "0.90000000", source: "ECB:2027-06-15" });
		const second = await recordInvoiceFacts(usd, ORG, opts(store, ecbBack));
		expect(second).toMatchObject({ recorded: true, snapshot: false, eurConverted: true });
		expect(writes[1]?.patch).toEqual({
			amountEurMinor: 90_00,
			eurRate: "0.90000000",
			eurRateSource: "ECB:2027-06-15",
		});
	});

	it("an invoice that was never mirrored records nothing", async () => {
		const { store } = memoryStore({ [ORG]: BG_ORG });
		expect(await recordInvoiceFacts(stripeInvoice(), ORG, opts(store))).toEqual({
			recorded: false,
			reason: "not_mirrored",
		});
	});
});

describe("recordInvoiceFacts — the alerts", () => {
	it("alerts once when a total rises to the warning margin, keyed on the threshold, not a customer", async () => {
		const { store, mirror } = memoryStore({ [ORG]: BG_ORG });
		mirror("in_old", {
			paidAt: new Date("2027-02-01T00:00:00Z"),
			amountEurMinor: 40_850_00, // + EUR 100 crosses 80% of 51,130 (40,904)
			country: "BG",
			capacity: "organization",
			vatIdGiven: false,
			eurRateSource: "EUR",
		});
		mirror("in_1");
		const res = await recordInvoiceFacts(stripeInvoice(), ORG, opts(store));
		expect(res).toMatchObject({ escalations: [expect.objectContaining({ key: "bg:2027", to: "warn" })] });
		expect(alertOperator).toHaveBeenCalledTimes(1);
		expect(vi.mocked(alertOperator).mock.calls[0]?.[0]).toMatchObject({
			subject: { type: "tax_threshold", id: "bg:2027" },
		});

		// The next invoice stays in the same band: no second alert.
		mirror("in_2");
		await recordInvoiceFacts(stripeInvoice({ id: "in_2" }), ORG, opts(store));
		expect(alertOperator).toHaveBeenCalledTimes(1);
	});

	it("a replay never re-alerts", async () => {
		const { store, mirror } = memoryStore({ [ORG]: { ...BG_ORG } });
		mirror("in_1", { amountMinor: 45_000_00 });
		await recordInvoiceFacts(stripeInvoice({ total: 45_000_00, total_excluding_tax: 45_000_00 }), ORG, opts(store));
		await recordInvoiceFacts(stripeInvoice({ total: 45_000_00, total_excluding_tax: 45_000_00 }), ORG, opts(store));
		expect(alertOperator).toHaveBeenCalledTimes(1);
	});

	it("an EU no-VAT sale with no EUR rate alerts that the EU total is unreadable", async () => {
		const { store, mirror } = memoryStore({
			[ORG]: { country: "FR", state: null, capacity: "consumer", vatIdStatus: null },
		});
		mirror("in_1", { currency: "usd" });
		await recordInvoiceFacts(stripeInvoice({ currency: "usd" }), ORG, opts(store));
		const titles = vi.mocked(alertOperator).mock.calls.map((c) => c[0].title);
		expect(titles).toContain("A paid invoice has no EUR amount");
		expect(titles.some((t) => t.includes("EU cross-border"))).toBe(true);
	});

	it("a US sale needs no EUR amount, so a missing rate raises no EUR alert", async () => {
		const { store, mirror } = memoryStore({
			[ORG]: { country: "US", state: "CA", capacity: "organization", vatIdStatus: null },
		});
		mirror("in_1", { currency: "usd" });
		await recordInvoiceFacts(stripeInvoice({ currency: "usd" }), ORG, opts(store));
		expect(alertOperator).not.toHaveBeenCalled();
	});
});

describe("the gate's read", () => {
	it("refuses the EU sale that would cross EUR 10,000, from the recorded rows", async () => {
		const { store, mirror } = memoryStore();
		mirror("in_old", {
			amountEurMinor: 9_990_00,
			country: "DE",
			capacity: "consumer",
			eurRateSource: "EUR",
		});
		const totals = await readTurnoverTotals(NOW, store);
		expect(totals.euCurrent.eurMinor).toBe(9_990_00);
		const sale = await assessSaleBeforeCharge(
			{ country: "ES", capacity: "consumer", vatIdGiven: null, amountEurMinor: 20_00 },
			{ now: NOW, store },
		);
		expect(sale.verdict).toBe("stop");
	});
});

describe("markRefundedInvoice", () => {
	/** A Stripe client whose invoice-payment lookup answers `invoiceId`. */
	const stripeWith = (invoiceId: string | null) => {
		const list = vi.fn(async () => ({ data: invoiceId ? [{ invoice: invoiceId }] : [] }));
		return { client: { invoicePayments: { list } } as unknown as Pick<Stripe, "invoicePayments">, list };
	};
	const charge = (over: Partial<Stripe.Charge>) =>
		({ id: "ch_1", payment_intent: "pi_1", refunded: false, ...over }) as unknown as Stripe.Charge;

	it("a FULL refund marks the invoice its PaymentIntent paid as refunded", async () => {
		const { client, list } = stripeWith("in_9");
		expect(await markRefundedInvoice(charge({ refunded: true }), client)).toBe("in_9");
		expect(list).toHaveBeenCalledWith({
			payment: { type: "payment_intent", payment_intent: "pi_1" },
			limit: 1,
		});
		expect(setInvoiceStatus).toHaveBeenCalledWith("in_9", "refunded");
	});

	it("a partial refund changes nothing, and asks Stripe nothing", async () => {
		const { client, list } = stripeWith("in_9");
		expect(await markRefundedInvoice(charge({ refunded: false, amount_refunded: 10 }), client)).toBeNull();
		expect(list).not.toHaveBeenCalled();
		expect(setInvoiceStatus).not.toHaveBeenCalled();
	});

	it("a charge that paid no invoice changes nothing", async () => {
		const { client } = stripeWith(null);
		expect(await markRefundedInvoice(charge({ refunded: true }), client)).toBeNull();
		expect(setInvoiceStatus).not.toHaveBeenCalled();
	});
});
