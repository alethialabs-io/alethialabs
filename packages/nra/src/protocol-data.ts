// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The second input `nra:protocol` accepts: a protocol the books workflow (alethialabs-io/books,
// tools/src/protocols/renderer.ts, `ProtocolData`) has already numbered and computed, in euro cents.
// The package re-checks every figure it can (ten-digit number, 20 %, the tax is 20 % of the base,
// the lines sum to the base, a full credit right) and then renders the same layout as a protocol it
// built itself, so the books' protocols and the console's cannot drift.

import { z } from "zod";
import type { Parsed } from "./input";
import { addDays, PROTOCOL_TAX_GROUND, type ReverseChargeProtocol, VAT_RATE_PERCENT, vatOf } from "./month";

/** YYYY-MM-DD. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** The books' ProtocolData. Unknown keys are ignored: the books may carry more than is printed. */
export const protocolDataSchema = z.object({
	number: z.string().regex(/^\d{10}$/, "the ten-digit protocol number"),
	issueDate: isoDate,
	taxEventDate: isoDate,
	issuer: z.object({ name: z.string().min(1), eik: z.string().min(1), vatNumber: z.string().regex(/^BG\d{9,10}$/) }),
	supplier: z.object({ name: z.string().min(1), country: z.string().regex(/^[A-Z]{2}$/), vatNumber: z.string().nullable() }),
	supplierDocument: z.object({ number: z.string().nullable(), date: isoDate }).nullable(),
	lines: z.array(z.object({ description: z.string().min(1), baseCents: z.number().int() })).min(1),
	baseCents: z.number().int(),
	ratePercent: z.number(),
	vatCents: z.number().int(),
	ground: z.string(),
	creditRight: z.enum(["full", "none"]),
	fxNote: z.string().nullable(),
});

/** The parsed ProtocolData. */
export type ProtocolData = z.infer<typeof protocolDataSchema>;

/** True when `raw` looks like the books' ProtocolData rather than a purchase request. */
export function isProtocolData(raw: unknown): boolean {
	return typeof raw === "object" && raw !== null && "baseCents" in raw && "vatCents" in raw;
}

/** The protocol of `raw`, checked, with the filer VAT number it was issued under; or the problems. */
export function protocolFromData(raw: unknown): Parsed<{ protocol: ReverseChargeProtocol; filerVat: string; notes: string[] }> {
	const parsed = protocolDataSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`) };
	const d = parsed.data;
	const problems: string[] = [];
	const notes: string[] = [];
	if (d.ratePercent !== VAT_RATE_PERCENT) problems.push(`ratePercent ${d.ratePercent}: a reverse-charge protocol is at ${VAT_RATE_PERCENT} %`);
	if (d.vatCents !== vatOf(d.baseCents)) problems.push(`vatCents ${d.vatCents} is not 20 % of baseCents ${d.baseCents}`);
	if (d.lines.reduce((n, l) => n + l.baseCents, 0) !== d.baseCents) problems.push("the lines do not sum to baseCents");
	if (d.creditRight !== "full") problems.push('creditRight "none": a company registered under чл. 100 keeps the credit; before the registration there is no protocol to issue');
	if (d.supplier.country === "BG") problems.push("a Bulgarian supplier charges its own VAT; there is no reverse charge to self-assess");
	if (!d.supplierDocument || !d.supplierDocument.number) problems.push("supplierDocument: the supplier's invoice number and date are required (чл. 117, ал. 2, т. 9)");
	if (d.issueDate < d.taxEventDate) problems.push(`issueDate ${d.issueDate} is before the tax event ${d.taxEventDate}`);
	if (d.ground && !d.ground.includes("82")) notes.push(`ground "${d.ground}" is not printed; the protocol states ${PROTOCOL_TAX_GROUND}.`);
	if (d.issueDate > addDays(d.taxEventDate, 15)) notes.push(`Protocol dated ${d.issueDate}, more than 15 days after the tax event ${d.taxEventDate} (чл. 117, ал. 3 ЗДДС).`);
	if (problems.length || !d.supplierDocument?.number) return { ok: false, problems };
	return {
		ok: true,
		value: {
			filerVat: d.issuer.vatNumber,
			notes,
			protocol: {
				number: d.number,
				issueDate: d.issueDate,
				taxEventDate: d.taxEventDate,
				supplier: d.supplier,
				supplierDocument: { number: d.supplierDocument.number, date: d.supplierDocument.date },
				// The books state the conversion as one sentence; it is printed as given, not re-derived.
				conversion: null,
				...(d.fxNote ? { conversionNote: d.fxNote } : {}),
				lines: d.lines.map((l) => ({ description: l.description, base: l.baseCents })),
				base: d.baseCents,
				vat: d.vatCents,
			},
		},
	};
}
