// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A full sample month for `factura:export -- --demo` (#7457), entirely from fixture data: no
// database, no Stripe, no network. It exists so the maintainer and the accountant can see the whole
// package the real run produces before the first real month. Every party, number and person here is
// invented; the summary of a demo run says so on its first line.
//
// December 2026:
//  - фактура 0000000101: a Bulgarian business, EUR, чл. 113, ал. 9 (not in the journals);
//  - фактура 0000000102: a German business with a DE VAT number, USD, at a fixed ECB rate (sales
//    journal 02-17 and VIES);
//  - credit note 0000000103: a partial refund of 0000000102;
//  - Stripe: Billing and Radar fees, and card-processing fees on the two charges;
//  - Google Workspace (Ireland, IE VAT number) and Anthropic (United States, no EU VAT number), as
//    reverse-charge purchases.

import type { EurRate } from "@/lib/billing/ecb-rate";
import type { FacturaSource } from "@/lib/billing/factura/checks";
import { buildCreditNoteSnapshot } from "@/lib/billing/factura/credit-note-snapshot";
import { type BalanceRow, monthWindow, type MonthWindow } from "@/lib/billing/factura/export";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import type { Factura } from "@/lib/db/schema";
import type { NraInput } from "./input";

/** The demo month. */
export const DEMO_MONTH = "2026-12";

/** The fixed USD rate of the demo: 1 USD = 0.95000000 EUR, as if published by the ECB on 2026-12-09. */
export const DEMO_USD_RATE: EurRate = { eurPerUnit: "0.95000000", source: "ECB:2026-12-09" };

/** Epoch seconds of a UTC date-time. */
function at(iso: string): number {
	return Date.parse(iso) / 1000;
}

/** A paid Stripe invoice of the demo. */
function invoice(over: Partial<FacturaSource> & Pick<FacturaSource, "id" | "currency" | "total">, paidAt: number): FacturaSource {
	return {
		number: null,
		customer_name: null,
		customer_address: null,
		customer_tax_ids: [],
		total_excluding_tax: over.total,
		status_transitions: { paid_at: paidAt, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
		lines: { data: [{ description: "Alethia Pro — 1 seat / 1 място", amount: over.total, quantity: 1, period: { start: paidAt, end: paidAt + 31 * 86_400 } }] },
		...over,
	};
}

/** A `factura` row for a snapshot, with no PDF yet (the caller renders and attaches it). */
function row(id: string, snapshot: Factura["snapshot"], kind: Factura["kind"], over: Partial<Factura> = {}): Factura {
	return {
		id,
		organizationId: "00000000-0000-4000-8000-000000000000",
		number: snapshot.number,
		kind,
		originalFacturaId: null,
		stripeInvoiceId: `in_demo_${id}`,
		stripeRefundId: null,
		issueDate: snapshot.issueDate,
		chargeableDate: snapshot.chargeableDate,
		snapshot,
		pdfKey: null,
		pdfSha256: null,
		createdAt: new Date(`${snapshot.issueDate}T12:00:00Z`),
		...over,
	};
}

/** The demo's documents: two фактури and one credit note. */
export function demoDocuments(): Factura[] {
	const bgPaid = at("2026-12-03T10:00:00Z");
	const bg = buildFacturaSnapshot(
		invoice(
			{
				id: "in_demo_bg",
				number: "DEMO-0101",
				currency: "eur",
				total: 4900,
				customer_name: "Примерна Фирма ЕООД",
				customer_address: { line1: "ул. Примерна 1", line2: null, city: "Пловдив", postal_code: "4000", state: null, country: "BG" },
				customer_tax_ids: [{ type: "bg_uic", value: "000000000" }],
			},
			bgPaid,
		),
		{ number: "0000000101", issueDate: "2026-12-03", chargeableDate: "2026-12-03", noVatGround: "чл. 113, ал. 9 ЗДДС", eurRate: null },
	);
	const dePaid = at("2026-12-10T09:00:00Z");
	const de = buildFacturaSnapshot(
		invoice(
			{
				id: "in_demo_de",
				number: "DEMO-0102",
				currency: "usd",
				total: 12000,
				customer_name: "Beispiel Software GmbH",
				customer_address: { line1: "Musterstraße 5", line2: null, city: "München", postal_code: "80331", state: null, country: "DE" },
				customer_tax_ids: [{ type: "eu_vat", value: "DE000000000" }],
			},
			dePaid,
		),
		{
			number: "0000000102",
			issueDate: "2026-12-10",
			chargeableDate: "2026-12-10",
			noVatGround: "чл. 21, ал. 2 ЗДДС, обратно начисляване / reverse charge",
			eurRate: DEMO_USD_RATE,
		},
	);
	const credit = buildCreditNoteSnapshot(de, 3000, { number: "0000000103", issueDate: "2026-12-18", chargeableDate: "2026-12-18" });
	return [
		row("demo-101", bg, "invoice"),
		row("demo-102", de, "invoice"),
		row("demo-103", credit, "credit_note", { originalFacturaId: "demo-102", stripeRefundId: "re_demo_103", stripeInvoiceId: "in_demo_demo-102" }),
	];
}

/** One demo balance transaction. */
function bt(over: Partial<BalanceRow> & Pick<BalanceRow, "id" | "created" | "type" | "amount">): BalanceRow {
	return {
		availableOn: over.created + 7 * 86_400,
		reportingCategory: over.type === "charge" ? "charge" : over.type === "refund" ? "refund" : "fee",
		description: null,
		currency: "eur",
		fee: 0,
		net: over.amount - (over.fee ?? 0),
		source: null,
		payoutId: "po_demo_1",
		...over,
	};
}

/** The demo's Stripe balance: two charges with processing fees, a refund, Billing and Radar fees. */
export function demoBalance(): BalanceRow[] {
	return [
		bt({ id: "txn_demo_1", created: at("2026-12-03T10:00:05Z"), type: "charge", amount: 4900, fee: 99, description: "Alethia Pro", source: "ch_demo_1" }),
		bt({ id: "txn_demo_2", created: at("2026-12-10T09:00:05Z"), type: "charge", amount: 11400, fee: 196, description: "Alethia Pro", source: "ch_demo_2" }),
		bt({ id: "txn_demo_3", created: at("2026-12-18T15:00:00Z"), type: "refund", amount: -2850, description: "Partial refund", source: "re_demo_103" }),
		bt({ id: "txn_demo_4", created: at("2026-12-31T21:00:00Z"), type: "stripe_fee", amount: -114, description: "Billing - Usage Fee (2026-12-01 - 2026-12-31)" }),
		bt({ id: "txn_demo_5", created: at("2026-12-31T21:00:01Z"), type: "stripe_fee", amount: -10, description: "Radar for Fraud Teams (2026-12-01 - 2026-12-31)" }),
	];
}

/** The operator input file of the demo. Every person and number in it is invented. */
export function demoOperatorInput(): NraInput {
	return {
		filer: { vatNumber: "BG208913663", submitter: "0000000000 Примерен Подател" },
		vies: {
			declarant: {
				personalId: "0000000000",
				name: "Примерен Подател Примеров",
				city: "София",
				postcode: "1111",
				address: "ул. Сирак Скитник № 9, вх. А, ет. 4, ап. 7",
				capacity: "R",
			},
			correspondenceAddress: "гр. София 1111, р-н Слатина, ул. Сирак Скитник № 9, вх. А, ет. 4, ап. 7",
		},
		protocols: { firstNumber: 1 },
		stripe: {
			supplier: { name: "Stripe Payments Europe, Limited", country: "IE", vatNumber: "IE0000000XX" },
			processingFees: "taxable",
			documentNumber: "DEMO-STRIPE-2026-12",
			documentDate: "2026-12-31",
		},
		purchases: [
			{
				supplier: { name: "Google Cloud EMEA Limited", country: "IE", vatNumber: "IE0000001XX" },
				documentNumber: "DEMO-GW-5550001",
				documentDate: "2026-12-01",
				description: "Google Workspace Business Starter",
				netEur: "6.80",
			},
			{
				supplier: { name: "Anthropic, PBC", country: "US", vatNumber: null },
				documentNumber: "DEMO-ANT-0042",
				documentDate: "2026-12-15",
				description: "Claude API usage",
				netEur: "42.17",
			},
		],
	};
}

/** Everything the demo run needs. */
export function demoMonth(): { window: MonthWindow; documents: Factura[]; balance: BalanceRow[]; operator: NraInput } {
	return { window: monthWindow(DEMO_MONTH), documents: demoDocuments(), balance: demoBalance(), operator: demoOperatorInput() };
}
