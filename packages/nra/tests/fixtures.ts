// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Builders for the test months: one base input file (registered under чл. 100 from 2026-12-01) and
// one document or purchase of each kind. Every number, name and person is invented. The inputs go
// through the package's own schemas (checkNraInput / checkSalesFile), so a fixture that the schema
// would refuse fails here, not deep inside a test.

import { checkNraInput, checkSalesFile, type NraInput, type NraInputFile, type SalesFile, type SalesFileInput } from "../src/input";

/** The filer's VAT number in every fixture. */
export const FILER_VAT = "BG208913663";

/** One purchase as the input file writes it. */
export type PurchaseFixture = NonNullable<NraInputFile["purchases"]>[number];
/** One issued document as facturi-M.json writes it. */
export type SaleFixture = SalesFileInput["documents"][number];

/** The input file of a month with `purchases`, and `over` merged on top. */
export function input(purchases: PurchaseFixture[] = [], over: Partial<NraInputFile> = {}): NraInput {
	const raw: NraInputFile = {
		version: 2,
		filer: { vatNumber: FILER_VAT, submitter: "0000000000 Примерен Подател" },
		registration: { basis: "chl100", effectiveDate: "2026-12-01" },
		vies: {
			declarant: {
				personalId: "0000000000",
				name: "Примерен Подател Примеров",
				city: "София",
				postcode: "1111",
				address: "ул. Примерна № 1",
				capacity: "R",
			},
			correspondenceAddress: "гр. София 1111, ул. Примерна № 1",
		},
		protocols: { series: "own", firstNumber: 1 },
		purchases,
		...over,
	};
	const parsed = checkNraInput(raw);
	if (!parsed.ok) throw new Error(`fixture input: ${parsed.problems.join("; ")}`);
	return parsed.value;
}

/** facturi-M.json of December 2026 with `documents`. */
export function sales(documents: SaleFixture[] = [], month = "2026-12"): SalesFile {
	const parsed = checkSalesFile({ version: 1, month, documents });
	if (!parsed.ok) throw new Error(`fixture sales: ${parsed.problems.join("; ")}`);
	return parsed.value;
}

/** A Bulgarian business, 49.00 + 20 %. */
export function domesticSale(over: Partial<SaleFixture> = {}): SaleFixture {
	return {
		kind: "invoice",
		number: "0000000101",
		issueDate: "2026-12-03",
		chargeableDate: "2026-12-03",
		recipient: { name: "Примерна Фирма ЕООД", country: "BG", vatNumber: "BG000000000", localId: null },
		description: "Alethia Pro",
		treatment: "bg_vat_20",
		currency: "EUR",
		amount: "49.00",
		eurRate: null,
		netEur: "49.00",
		vatEur: "9.80",
		original: null,
		...over,
	};
}

/** A German business with a DE VAT number, USD 120.00 at 0.95. */
export function euSale(over: Partial<SaleFixture> = {}): SaleFixture {
	return {
		kind: "invoice",
		number: "0000000102",
		issueDate: "2026-12-10",
		chargeableDate: "2026-12-10",
		recipient: { name: "Beispiel Software GmbH", country: "DE", vatNumber: "DE000000000", localId: null },
		description: "Alethia Pro",
		treatment: "eu_b2b_services_21_2",
		currency: "USD",
		amount: "120.00",
		eurRate: "0.95000000",
		netEur: "114.00",
		vatEur: "0",
		original: null,
		...over,
	};
}

/** A partial refund of euSale, USD 30.00. */
export function euCreditNote(over: Partial<SaleFixture> = {}): SaleFixture {
	return euSale({
		kind: "credit_note",
		number: "0000000103",
		issueDate: "2026-12-18",
		chargeableDate: "2026-12-18",
		description: "Възстановена сума по фактура № 0000000102",
		amount: "-30.00",
		netEur: "-28.50",
		vatEur: "0",
		original: { number: "0000000102", issueDate: "2026-12-10" },
		...over,
	});
}

/** The month's supply to Paddle.com Market Ltd (UK). */
export function paddleSale(over: Partial<SaleFixture> = {}): SaleFixture {
	return {
		kind: "invoice",
		number: "0000000104",
		issueDate: "2026-12-31",
		chargeableDate: "2026-12-31",
		recipient: { name: "Paddle.com Market Ltd", country: "GB", vatNumber: "GB000000000", localId: null },
		description: "Supply to Paddle 12/2026",
		treatment: "outside_eu_69_2",
		currency: "EUR",
		amount: "1234.56",
		eurRate: null,
		netEur: "1234.56",
		vatEur: "0",
		original: null,
		...over,
	};
}

/** A reverse-charge service from AWS (Luxembourg), EUR. */
export function awsPurchase(over: Partial<PurchaseFixture> = {}): PurchaseFixture {
	return {
		supplier: { name: "Amazon Web Services EMEA SARL", country: "LU", vatNumber: "LU00000000" },
		documentNumber: "AWS-0001",
		documentDate: "2026-12-31",
		taxEventDate: "2026-12-31",
		description: "AWS usage 12/2026",
		currency: "EUR",
		amount: "100.00",
		eurRate: null,
		netEur: "100.00",
		treatment: "rc_services_82_2",
		...over,
	};
}

/** A reverse-charge service from Anthropic (US, no EU VAT number), USD 50.00 at 0.95. */
export function anthropicPurchase(over: Partial<PurchaseFixture> = {}): PurchaseFixture {
	return {
		supplier: { name: "Anthropic, PBC", country: "US", vatNumber: null },
		documentNumber: "ANT-0042",
		documentDate: "2026-12-15",
		taxEventDate: "2026-12-15",
		description: "Claude API usage",
		currency: "USD",
		amount: "50.00",
		eurRate: "0.95000000",
		netEur: "47.50",
		treatment: "rc_services_82_2",
		...over,
	};
}

/** A Bulgarian accountant's фактура, 100.00 + 20.00, full credit. */
export function bgPurchase(over: Partial<PurchaseFixture> = {}): PurchaseFixture {
	return {
		supplier: { name: "Примерен Счетоводител ООД", country: "BG", vatNumber: "BG000000001" },
		documentNumber: "0000004711",
		documentDate: "2026-12-10",
		taxEventDate: "2026-12-10",
		description: "Счетоводни услуги",
		currency: "EUR",
		amount: "100.00",
		eurRate: null,
		netEur: "100.00",
		vatEur: "20.00",
		treatment: "bg_vat_full_credit",
		...over,
	};
}

/** Stripe's card-processing fee, exempt: outside the journals. */
export function stripeFee(over: Partial<PurchaseFixture> = {}): PurchaseFixture {
	return {
		supplier: { name: "Stripe Payments Europe, Limited", country: "IE", vatNumber: "IE0000000XX" },
		documentNumber: "STRIPE-2026-12",
		documentDate: "2026-12-31",
		taxEventDate: "2026-12-31",
		description: "Card processing fees",
		currency: "EUR",
		amount: "2.95",
		eurRate: null,
		netEur: "2.95",
		treatment: "outside_journal",
		...over,
	};
}
