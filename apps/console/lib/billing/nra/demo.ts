// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A full sample month for `factura:export -- --demo`, entirely from fixture data: no database, no
// Stripe, no network. It exists so the maintainer and the accountant can see the whole package a
// real month produces under the чл. 100 registration before the first real month. Every number,
// address and person here is invented (Paddle and the vendors are named as the real counterparties
// would be, with placeholder VAT numbers); the summary of a demo run says so on its first line.
//
// December 2026, registration effective 2026-12-01:
//  - фактура 0000000101: a Bulgarian business, EUR 49.00 + 20 % VAT (02-11 / 02-21);
//  - фактура 0000000102: a German business with a DE VAT number, USD 120.00 at a fixed ECB rate
//    (02-17 and VIES);
//  - credit note 0000000103: a partial refund of 0000000102 (02-17 negative, VIES net);
//  - фактура 0000000104: the month's supply to Paddle.com Market Ltd (UK), the merchant of record
//    for card sales (02-18, чл. 69, ал. 2);
//  - received: AWS (Luxembourg, USD), Anthropic and GitHub (US, no EU VAT number) as reverse-charge
//    services with чл. 117 protocols; a Bulgarian accountant's фактура with VAT (full credit); and
//    Stripe's card-processing fee, exempt and outside the journals.
// The фактури themselves are not yet issued with VAT by the console (that is the фактура work of the
// чл. 100 switch); the demo sets the VAT on 0000000101's snapshot so its PDF matches the journal.

import type { NraInput } from "@repo/nra";
import type { EurRate } from "@/lib/billing/ecb-rate";
import type { FacturaSource } from "@/lib/billing/factura/checks";
import { buildCreditNoteSnapshot } from "@/lib/billing/factura/credit-note-snapshot";
import { type MonthWindow, monthWindow } from "@/lib/billing/factura/export";
import { buildFacturaSnapshot } from "@/lib/billing/factura/snapshot";
import type { Factura } from "@/lib/db/schema";

/** The demo month. */
const DEMO_MONTH = "2026-12";

/** The fixed USD rate of the demo: 1 USD = 0.95000000 EUR, as if published by the ECB on 2026-12-09. */
const DEMO_USD_RATE: EurRate = { eurPerUnit: "0.95000000", source: "ECB:2026-12-09" };

/** Epoch seconds of a UTC date-time. */
function at(iso: string): number {
	return Date.parse(iso) / 1000;
}

/** A paid Stripe-shaped invoice of the demo. */
function invoice(over: Partial<FacturaSource> & Pick<FacturaSource, "id" | "currency" | "total">, paidAt: number, description: string): FacturaSource {
	return {
		number: null,
		customer_name: null,
		customer_address: null,
		customer_tax_ids: [],
		total_excluding_tax: over.total,
		status_transitions: { paid_at: paidAt, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
		lines: { data: [{ description, amount: over.total, quantity: 1, period: { start: paidAt, end: paidAt + 31 * 86_400 } }] },
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
		source: "stripe",
		manualKey: null,
		issueDate: snapshot.issueDate,
		chargeableDate: snapshot.chargeableDate,
		snapshot,
		pdfKey: null,
		pdfSha256: null,
		createdAt: new Date(`${snapshot.issueDate}T12:00:00Z`),
		...over,
	};
}

/** The demo's documents: three фактури and one credit note. */
function demoDocuments(): Factura[] {
	const bgPaid = at("2026-12-03T10:00:00Z");
	const bgNet = buildFacturaSnapshot(
		invoice(
			{
				id: "in_demo_bg",
				number: "DEMO-0101",
				currency: "eur",
				total: 4900,
				customer_name: "Примерна Фирма ЕООД",
				customer_address: { line1: "ул. Примерна 1", line2: null, city: "Пловдив", postal_code: "4000", state: null, country: "BG" },
				customer_tax_ids: [{ type: "eu_vat", value: "BG000000000" }],
			},
			bgPaid,
			"Alethia Pro — 1 seat / 1 място",
		),
		{ number: "0000000101", issueDate: "2026-12-03", chargeableDate: "2026-12-03", noVatGround: "", eurRate: null },
	);
	const bg = { ...bgNet, vatMinor: 980, totalMinor: 5880, noVatGround: null };
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
			"Alethia Pro — 1 seat / 1 място",
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
	const paddle = buildFacturaSnapshot(
		invoice(
			{
				id: "in_demo_paddle",
				number: "DEMO-0104",
				currency: "eur",
				total: 123456,
				customer_name: "Paddle.com Market Ltd",
				customer_address: { line1: "1 Example Street", line2: null, city: "London", postal_code: "EC1A 1AA", state: null, country: "GB" },
				customer_tax_ids: [{ type: "gb_vat", value: "GB000000000" }],
			},
			at("2026-12-31T20:00:00Z"),
			"Alethia subscriptions supplied to Paddle, 12/2026",
		),
		{
			number: "0000000104",
			issueDate: "2026-12-31",
			chargeableDate: "2026-12-31",
			noVatGround: "чл. 21, ал. 2 ЗДДС, място на изпълнение извън страната / place of supply outside Bulgaria",
			eurRate: null,
		},
	);
	return [
		row("demo-101", bg, "invoice"),
		row("demo-102", de, "invoice"),
		row("demo-103", credit, "credit_note", { originalFacturaId: "demo-102", stripeRefundId: "re_demo_103", stripeInvoiceId: "in_demo_demo-102" }),
		row("demo-104", paddle, "invoice", { stripeInvoiceId: "manual_demo_104" }),
	];
}

/** The operator input file of the demo (version 2). Every person and number in it is invented. */
function demoOperatorInput(): NraInput {
	const usd = (amount: string, netEur: string) => ({ currency: "USD", amount, eurRate: "0.95000000", netEur });
	return {
		version: 2,
		filer: { vatNumber: "BG208913663", submitter: "0000000000 Примерен Подател" },
		registration: { basis: "chl100", effectiveDate: "2026-12-01" },
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
		protocols: { series: "own", firstNumber: 1 },
		purchases: [
			{
				supplier: { name: "GitHub, Inc.", country: "US", vatNumber: null },
				kind: "invoice",
				documentNumber: "DEMO-GH-1205",
				documentDate: "2026-12-05",
				taxEventDate: "2026-12-05",
				description: "GitHub Team, 12/2026",
				...usd("4.00", "3.80"),
				treatment: "rc_services_82_2",
			},
			{
				supplier: { name: "Примерен Счетоводител ООД", country: "BG", vatNumber: "BG000000001" },
				kind: "invoice",
				documentNumber: "0000004711",
				documentDate: "2026-12-10",
				taxEventDate: "2026-12-10",
				description: "Счетоводни услуги 11/2026",
				currency: "EUR",
				amount: "100.00",
				eurRate: null,
				netEur: "100.00",
				vatEur: "20.00",
				treatment: "bg_vat_full_credit",
			},
			{
				supplier: { name: "Anthropic, PBC", country: "US", vatNumber: null },
				kind: "invoice",
				documentNumber: "DEMO-ANT-0042",
				documentDate: "2026-12-15",
				taxEventDate: "2026-12-15",
				description: "Claude API usage",
				...usd("50.00", "47.50"),
				treatment: "rc_services_82_2",
			},
			{
				supplier: { name: "Amazon Web Services EMEA SARL", country: "LU", vatNumber: "LU00000000" },
				kind: "invoice",
				documentNumber: "DEMO-AWS-EUINBG26-0001",
				documentDate: "2026-12-31",
				taxEventDate: "2026-12-31",
				description: "Amazon Web Services, usage 12/2026",
				...usd("212.40", "201.78"),
				treatment: "rc_services_82_2",
			},
			{
				supplier: { name: "Stripe Payments Europe, Limited", country: "IE", vatNumber: "IE0000000XX" },
				kind: "invoice",
				documentNumber: "DEMO-STRIPE-2026-12",
				documentDate: "2026-12-31",
				taxEventDate: "2026-12-31",
				description: "Card processing fees 12/2026",
				currency: "EUR",
				amount: "2.95",
				eurRate: null,
				netEur: "2.95",
				treatment: "outside_journal",
			},
		],
	};
}

/** Everything the demo run needs. */
export function demoMonth(): { window: MonthWindow; documents: Factura[]; operator: NraInput } {
	return { window: monthWindow(DEMO_MONTH), documents: demoDocuments(), operator: demoOperatorInput() };
}
