// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Contract formation and consumer-rights records (#2372).
//
// These two tables are EVIDENCE, not application state. They answer the questions that arrive
// months later from a customer, an auditor or a consumer-protection authority — "what exactly did
// this person agree to, when, and as whom?" — and they answer them without depending on Stripe
// still holding a session or on the marketing site still rendering the same words.
//
// Two design rules follow from that, and both are load-bearing:
//
//  1. **Everything is snapshotted, nothing is joined for the facts that mattered at the time.** The
//     document version AND its content hash are copied in; the price, currency, country and
//     capacity are copied in. A record that resolves `LEGAL_DOCUMENTS` at read time would silently
//     re-describe the past every time the copy changes.
//  2. **Rows are append-only in spirit.** Nothing here is updated to erase what it said; an order's
//     lifecycle moves forward through `state` and the withdrawal/cancellation columns record what
//     happened rather than replacing it.

import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	CommerceBillingAddress,
	CommerceDocumentVersions,
	LegalAcceptanceEvidence,
} from "@/types/jsonb.types";
import {
	commerceOrderState,
	legalAcceptanceContext,
	payerCapacity,
	performanceStart,
} from "./enums";
import { organization } from "./organizations";
import { user } from "./auth";

/**
 * One acceptance of one legal document by one user.
 *
 * NOT unique per (user, document): a new version needs a new acceptance, and the old row must
 * survive to prove what was agreed before. "Has this user accepted the CURRENT terms?" is therefore
 * a query for a row at the current version, never a boolean on the user.
 *
 * `organizationId` is nullable because the first acceptance happens at signup, before any org
 * exists — and requiring one there would either block signup or invent a placeholder org.
 */
export const legalAcceptance = pgTable(
	"legal_acceptance",
	{
		id: uuid().primaryKey().defaultRandom(),
		userId: uuid()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: uuid().references(() => organization.id, {
			onDelete: "cascade",
		}),
		/** The document id from @repo/legal LEGAL_DOCUMENTS (`terms`, …). */
		documentId: text().notNull(),
		/** SNAPSHOT of the version accepted. Never resolved at read time. */
		documentVersion: text().notNull(),
		/** SNAPSHOT of the sealed content hash — what makes the version reproducible. */
		documentHash: text().notNull(),
		/** The locale the document was presented in, e.g. `en` or `bg-BG`. */
		locale: text().notNull(),
		context: legalAcceptanceContext().notNull(),
		acceptedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/**
		 * Request evidence: the IP and user agent that submitted the acceptance.
		 *
		 * Personal data, and kept deliberately narrow for that reason — it is the minimum that makes
		 * an acceptance attributable, and it is retained under the same schedule as the contract it
		 * evidences (docs/legal/). Typed, never `Record<string, unknown>`.
		 */
		evidence: jsonb().$type<LegalAcceptanceEvidence>().notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// The hot path is "does this user have a row at the current version of this document?", asked
		// on every request that passes the acceptance gate.
		index("legal_acceptance_user_document_idx").on(
			t.userId,
			t.documentId,
			t.documentVersion,
		),
		index("legal_acceptance_org_idx").on(t.organizationId),
	],
);

export type LegalAcceptance = typeof legalAcceptance.$inferSelect;
export type LegalAcceptanceInsert = typeof legalAcceptance.$inferInsert;

/**
 * One paid order, recorded at the moment it is placed.
 *
 * This is the "capture payer capacity, authority, address, price and applicable documents" half of
 * the commerce duties, and the reason it is a table rather than Stripe metadata is that Stripe
 * cannot hold the facts that are ABOUT the contract rather than the payment: which capacity the
 * payer declared, whether they claimed authority to bind an organization, which document versions
 * were in force, and — for a consumer — the two withdrawal choices whose absence decides whether a
 * single cent may be retained on withdrawal.
 */
export const commerceOrder = pgTable(
	"commerce_order",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The user who placed it. Retained even if they later leave the org. */
		placedByUserId: uuid()
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		state: commerceOrderState().default("placed").notNull(),

		// ── Who is paying, and under what authority ──────────────────────────────────────────────
		capacity: payerCapacity().notNull(),
		/**
		 * For an `organization` order: the payer's attestation that they can bind it, in their own
		 * submitted form (role/title). Null for a consumer order, where there is nothing to bind.
		 */
		authorityAttestation: text(),
		/** ISO 3166-1 alpha-2, upper-case. Decides the paid-market cell and the tax treatment. */
		billingCountry: text().notNull(),
		/** SNAPSHOT of the billing address as given. Typed; never a loose record. */
		billingAddress: jsonb().$type<CommerceBillingAddress>().notNull(),
		/** VAT/tax id, when supplied. Optional by law and by design — never a gate on paying. */
		taxId: text(),

		// ── What was charged ─────────────────────────────────────────────────────────────────────
		/** TOTAL, TAX-INCLUSIVE, in minor units. The figure the consumer must be shown before
		 *  ordering — storing a net amount here would make the record disagree with the duty. */
		totalMinorUnits: integer().notNull(),
		currency: text().notNull(),
		/** The plan or product ordered, as the product names it. */
		productId: text().notNull(),
		/** Length of the billed period in days — the denominator of the withdrawal proportion. */
		periodDays: integer().notNull(),
		/** Renewal facts, stated at order time: whether it renews and on what notice. Both are
		 *  pre-contractual information a consumer must be given BEFORE ordering (CRD art. 6), so
		 *  they are snapshotted here rather than resolved from the plan catalogue later. */
		renewsAutomatically: boolean().notNull(),
		cancellationNoticeDays: integer().notNull(),

		// ── The documents in force, snapshotted ──────────────────────────────────────────────────
		documentVersions: jsonb().$type<CommerceDocumentVersions>().notNull(),

		// ── Consumer rights (null for an organization order) ─────────────────────────────────────
		/** Whether the consumer asked for performance to start inside the withdrawal period. */
		performanceStart: performanceStart(),
		/**
		 * Whether they ALSO acknowledged owing a proportion of the price on withdrawal.
		 *
		 * Stored separately from `performanceStart` because the two are separate legal acts and the
		 * missing one has a price: a consumer who requested immediate performance WITHOUT this
		 * acknowledgement can withdraw and owe nothing at all (CRD art. 14(3)). Folding them into one
		 * boolean would make that unrecoverable.
		 */
		proportionalChargeAcknowledgedAt: timestamp({ withTimezone: true }),
		/** When the statutory withdrawal period expires. */
		withdrawalPeriodEndsAt: timestamp({ withTimezone: true }),
		withdrawnAt: timestamp({ withTimezone: true }),
		/** What was retained and refunded on withdrawal, in minor units. */
		withdrawalRetainedMinorUnits: integer(),
		withdrawalRefundMinorUnits: integer(),

		// ── Ordinary cancellation (a different fact, with different money) ───────────────────────
		cancelledAt: timestamp({ withTimezone: true }),
		/** When access actually ends — the paid period's end, never the cancellation instant. */
		accessEndsAt: timestamp({ withTimezone: true }),

		/** Stripe linkage, when the order reached a payment. */
		stripeSubscriptionId: text(),
		stripePaymentIntentId: text(),

		placedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("commerce_order_org_idx").on(t.organizationId),
		index("commerce_order_state_idx").on(t.state),
		index("commerce_order_subscription_idx").on(t.stripeSubscriptionId),
	],
);

export type CommerceOrder = typeof commerceOrder.$inferSelect;
export type CommerceOrderInsert = typeof commerceOrder.$inferInsert;

/** Re-exported from the JSONB type module so a consumer of this schema gets the shapes with it. */
export type {
	CommerceBillingAddress,
	CommerceDocumentVersions,
	LegalAcceptanceEvidence,
} from "@/types/jsonb.types";
