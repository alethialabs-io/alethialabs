// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The snapshot of a credit note (кредитно известие, Art. 115 ЗДДС), as a pure function (#7369).
// It lives apart from the issuer (credit-note.ts) so that code with no server around it — the
// accountant export's `--demo` fixtures (lib/billing/nra/demo.ts, #7457), run under plain tsx — can
// build a credit note exactly as the issuer does without importing the database, storage and alert
// modules the issuer needs. What is printed and why is described in credit-note.ts.

import type { FacturaLine, FacturaSnapshot } from "@/types/jsonb.types";

/** The document name of a credit note (Art. 115 ЗДДС). */
export const CREDIT_NOTE_DOCUMENT_NAME = "КРЕДИТНО ИЗВЕСТИЕ";

/** What the snapshot of a credit note needs beyond the original and the refund. */
export interface CreditNoteInputs {
	/** The ten-digit number taken from the series. */
	number: string;
	/** YYYY-MM-DD. */
	issueDate: string;
	/** YYYY-MM-DD: the day of the refund. */
	chargeableDate: string;
}

/** A line with its amounts negated, for a full refund. */
function negated(l: FacturaLine): FacturaLine {
	return { ...l, unitAmountMinor: -l.unitAmountMinor, amountMinor: -l.amountMinor };
}

/** The EUR equivalent of `amountMinor` at a recorded rate, rounded half away from zero. */
function eurAt(amountMinor: number, rate: string): number {
	return Math.round(amountMinor * Number(rate));
}

/**
 * The snapshot of the credit note for `refundMinor` of the фактура `original`. Pure: the same inputs
 * always give the same snapshot, so its PDF is reproducible.
 */
export function buildCreditNoteSnapshot(
	original: FacturaSnapshot,
	refundMinor: number,
	input: CreditNoteInputs,
): FacturaSnapshot {
	const full = refundMinor === original.totalMinor;
	const lines: FacturaLine[] = full
		? original.lines.map(negated)
		: [
				{
					description: `Възстановена сума по фактура № ${original.number} / Refund against invoice No. ${original.number}`,
					quantity: 1,
					unitAmountMinor: -refundMinor,
					amountMinor: -refundMinor,
					periodStart: null,
					periodEnd: null,
				},
			];
	const eur = original.eurEquivalent;
	return {
		version: 1,
		documentName: CREDIT_NOTE_DOCUMENT_NAME,
		number: input.number,
		issueDate: input.issueDate,
		chargeableDate: input.chargeableDate,
		supplier: original.supplier,
		recipient: original.recipient,
		lines,
		currency: original.currency,
		taxBaseMinor: -refundMinor,
		vatMinor: 0,
		totalMinor: -refundMinor,
		noVatGround: original.noVatGround,
		eurEquivalent: eur
			? {
					taxBaseEurMinor: full ? -eur.taxBaseEurMinor : -eurAt(refundMinor, eur.rate),
					vatEurMinor: 0,
					rate: eur.rate,
					rateDate: eur.rateDate,
					source: eur.source,
				}
			: null,
		original: { number: original.number, issueDate: original.issueDate },
		reason: full
			? "Пълно възстановяване на плащането / Full refund of the payment"
			: "Частично възстановяване на плащането / Partial refund of the payment",
		stripeInvoiceNumber: original.stripeInvoiceNumber,
	};
}
