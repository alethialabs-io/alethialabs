// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared fixtures for the фактура tests: a paid Stripe invoice with every Art. 114(1) recipient
// detail, in EUR or USD, and the fixed ECB rate the USD one is converted at.

import type { EurRate } from "@/lib/billing/ecb-rate";
import type { FacturaSource } from "@/lib/billing/factura/checks";

/** 2027-01-15 09:00 UTC, the payment. */
export const PAID_AT = Date.UTC(2027, 0, 15, 9, 0, 0) / 1000;

/** The ECB rate the USD fixture is converted at: 1 USD = 0.92000000 EUR, published 2027-01-14. */
export const USD_RATE: EurRate = { eurPerUnit: "0.92000000", source: "ECB:2027-01-14" };

/** A paid Stripe invoice for one Pro seat; `over` replaces fields. */
export function paidInvoice(over: Partial<FacturaSource> = {}): FacturaSource {
	return {
		id: "in_test_1",
		number: "OQDLWV3B-0031",
		currency: "eur",
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
		total: 5500,
		total_excluding_tax: 5500,
		status_transitions: { paid_at: PAID_AT, finalized_at: null, marked_uncollectible_at: null, voided_at: null },
		lines: {
			data: [
				{
					description: "Alethia Pro — 1 seat",
					amount: 5500,
					quantity: 1,
					period: { start: PAID_AT, end: PAID_AT + 31 * 86400 },
				},
			],
		},
		...over,
	};
}
