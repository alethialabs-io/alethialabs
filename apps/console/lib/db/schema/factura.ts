// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Bulgarian фактура of record (#7367, INV-S): the console issues it itself from Stripe's paid
// invoice, so the number series and the issued documents live here.
//
// THE NUMBER. Art. 114(1), point 2 ЗДДС asks for "пореден десетразряден номер, съдържащ само арабски
// цифри", and the series may have no gaps. `factura_series` holds one row per series (today only
// `BG`, seeded by programmables.sql). The issuer takes the next number with
// `UPDATE factura_series SET last_number = last_number + 1 WHERE id = 'BG' RETURNING last_number`
// INSIDE the transaction that inserts the `factura` row. The row lock serialises concurrent issuers,
// and a rollback returns the number with everything else, so no number is ever skipped. A Postgres
// SEQUENCE would not do: `nextval` is not rolled back, so a failed issue would leave a gap.
//
// THE DOCUMENT. One `factura` row per issued фактура or credit note (кредитно известие, Art. 115,
// one per Stripe refund: lib/billing/factura/credit-note.ts). A `manual` row (L6b,
// lib/billing/factura/manual.ts) is one an operator issued for a supply no checkout produced; it
// names an operator key instead of Stripe ids, and takes its number from the same series. `snapshot` holds every Art. 114
// field as printed (FacturaSnapshot in types/jsonb.types.ts); the PDF is rendered from it alone, and
// `pdf_sha256` proves the stored PDF unchanged. A trigger in programmables.sql refuses UPDATE, DELETE
// and TRUNCATE on an issued row. The one write it admits is attaching the PDF ONCE (pdf_key and
// pdf_sha256 from NULL to a value, together), because the number and snapshot are committed before
// the PDF is rendered and uploaded: if the upload fails the legal document still exists and is
// re-rendered later, and its number is never lost or reused.
//
// NO FOREIGN KEY TO organization. The records are kept for ten years (Accountancy Act Art. 12, and
// Art. 121(1) ЗДДС for the invoice itself), longer than an organization may exist. A cascade would
// try to delete them and a restrict would block the organization's deletion, so the row keeps the
// organization id as a plain value and the recipient's details in its snapshot.
//
// RLS (programmables.sql): an organization's members may read its own rows; every write goes
// through the service role.

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	check,
	date,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { FacturaSnapshot } from "@/types/jsonb.types";

/** The kinds of document in the series: a фактура, or a credit note correcting one (Art. 115). */
export const FACTURA_KINDS = ["invoice", "credit_note"] as const;

/** One of `FACTURA_KINDS`. */
export type FacturaKind = (typeof FACTURA_KINDS)[number];

/**
 * Where a document came from (L6b): `stripe`, issued from a paid Stripe invoice or refund by
 * issue.ts / credit-note.ts; `manual`, issued by an operator through `factura:issue-manual`
 * (manual.ts) for a supply no checkout produced — the monthly фактура to Paddle, an Enterprise
 * contract. Both draw from the same series.
 */
export const FACTURA_DOCUMENT_SOURCES = ["stripe", "manual"] as const;

/** One of `FACTURA_DOCUMENT_SOURCES`. */
export type FacturaDocumentSource = (typeof FACTURA_DOCUMENT_SOURCES)[number];

/** The id of the one series the console issues from. */
export const FACTURA_SERIES_BG = "BG";

/** The largest number ten digits can hold. */
export const FACTURA_NUMBER_MAX = 9_999_999_999;

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

/** The gap-free counter: one row per series, holding the last number issued in it (0 before any). */
export const facturaSeries = pgTable(
	"factura_series",
	{
		id: text().primaryKey(),
		lastNumber: bigint({ mode: "number" }).notNull().default(0),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	() => [
		check(
			"factura_series_ten_digits",
			sql.raw(`last_number >= 0 AND last_number <= ${FACTURA_NUMBER_MAX}`),
		),
	],
);

/** An issued фактура or credit note. Immutable once inserted, except for the one-time PDF attach. */
export const factura = pgTable(
	"factura",
	{
		id: uuid().primaryKey().defaultRandom(),
		/**
		 * The organization billed. Deliberately not a foreign key: see the header. Always set on a
		 * `stripe` document; a `manual` one names it only when the recipient is a console
		 * organization (an Enterprise contract), so its members can read it — the monthly фактура to
		 * Paddle names none and is read by the operator alone.
		 */
		organizationId: uuid(),
		/** Where the document came from (`FACTURA_DOCUMENT_SOURCES`). */
		source: text().$type<FacturaDocumentSource>().notNull().default("stripe"),
		/** The ten-digit number (Art. 114(1), point 2), zero-padded: "0000000001". */
		number: text().notNull().unique(),
		kind: text().$type<FacturaKind>().notNull(),
		/** For a credit note: the фактура it corrects. NULL on a фактура. */
		originalFacturaId: uuid().references((): AnyPgColumn => factura.id, {
			onDelete: "restrict",
		}),
		/**
		 * The paid Stripe invoice this document is issued for (for a credit note: the one it corrects).
		 * Set exactly on a `stripe` document.
		 */
		stripeInvoiceId: text(),
		/**
		 * For a credit note: the Stripe refund it records (#7369). One refund, one credit note, so a
		 * partial refund and a later one each get their own. NULL on a фактура.
		 */
		stripeRefundId: text(),
		issueDate: date({ mode: "string" }).notNull(),
		/** The date of the chargeable event (Art. 25 ЗДДС). */
		chargeableDate: date({ mode: "string" }).notNull(),
		/** Every Art. 114 field as printed. */
		snapshot: jsonb().$type<FacturaSnapshot>().notNull(),
		/**
		 * The operator's idempotency key of a `manual` document (e.g. `paddle-market:2026-12`): a
		 * re-run with the same key finds the issued document instead of taking a second number. Set
		 * exactly on a `manual` document, and unique across both kinds.
		 */
		manualKey: text(),
		/** The rendered PDF's object-storage key (lib/storage/invoice-pdf.ts). Set once. */
		pdfKey: text(),
		/** The SHA-256 of the stored PDF, lower-case hex. Set once, with `pdfKey`. */
		pdfSha256: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// Idempotency: one фактура per Stripe invoice (its refund id is NULL, and NULLs compare equal
		// here), and one credit note per Stripe refund (#7369). A replay or a racing issuer conflicts.
		// `manual_key` is in the key so two manual documents (Stripe columns both NULL) differ by it;
		// on a `stripe` row it is always NULL, so the key means what it meant before L6b.
		unique("factura_document_key")
			.on(t.stripeInvoiceId, t.kind, t.stripeRefundId, t.manualKey)
			.nullsNotDistinct(),
		// One manual document per operator key, whatever its kind (NULLs distinct: Stripe rows).
		unique("factura_manual_key").on(t.manualKey),
		index("factura_org_idx").on(t.organizationId),
		index("factura_issue_date_idx").on(t.issueDate),
		// A Stripe credit note names the refund it records; a Stripe фактура names none. A manual
		// document names no Stripe object at all (`factura_source_link`).
		check(
			"factura_credit_note_has_refund",
			sql`source <> 'stripe' OR (kind = 'credit_note') = (stripe_refund_id IS NOT NULL)`,
		),
		check("factura_source_known", sql.raw(`source IN (${sqlList(FACTURA_DOCUMENT_SOURCES)})`)),
		// A Stripe document names its invoice and organization and no manual key; a manual one names
		// its key and no Stripe object.
		check(
			"factura_source_link",
			sql`(source = 'stripe' AND stripe_invoice_id IS NOT NULL AND organization_id IS NOT NULL AND manual_key IS NULL)
			OR (source = 'manual' AND stripe_invoice_id IS NULL AND stripe_refund_id IS NULL AND manual_key IS NOT NULL)`,
		),
		check("factura_number_ten_digits", sql`number ~ '^[0-9]{10}$'`),
		check("factura_kind_known", sql.raw(`kind IN (${sqlList(FACTURA_KINDS)})`)),
		// A credit note names the фактура it corrects; a фактура names none.
		check(
			"factura_credit_note_has_original",
			sql`(kind = 'credit_note') = (original_factura_id IS NOT NULL)`,
		),
		// The PDF key and its hash arrive together.
		check("factura_pdf_pair", sql`(pdf_key IS NULL) = (pdf_sha256 IS NULL)`),
		check("factura_pdf_sha256_hex", sql`pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'`),
	],
);

export type FacturaSeries = typeof facturaSeries.$inferSelect;
export type Factura = typeof factura.$inferSelect;
export type FacturaInsert = typeof factura.$inferInsert;
