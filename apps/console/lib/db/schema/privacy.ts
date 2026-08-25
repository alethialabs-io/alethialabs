// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Data-subject requests, and what was done about them (#2373).
//
// A privacy request is a legal process with a clock, an identity check, a decision, and a duty to
// explain a refusal. Handling it in an inbox produces none of that as evidence — which is why the
// runbook this replaces could describe a good process without being able to demonstrate one.
//
// Three tables, and the split is the design:
//
//   privacy_case              the request, its deadline, its decision
//   privacy_case_event        append-only ledger of everything that happened on it
//   privacy_erasure_tombstone what was erased, kept AFTER the data is gone
//
// The tombstone is the one that looks redundant and is not. A backup restored after an erasure
// silently reinstates the data; the tombstone is what a restore replays against, so it has to
// outlive both the case and the person. That is why it holds a HASH of the identifier rather than
// the identifier — it must survive erasure without becoming the thing it was meant to remove.

import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	PrivacyCaseScope,
	PrivacyEventDetail,
	PrivacyExportManifest,
} from "@/types/jsonb.types";
import {
	privacyCaseEventKind,
	privacyCaseKind,
	privacyCaseState,
} from "./enums";
import { organization } from "./organizations";
import { user } from "./auth";

/**
 * One data-subject request.
 *
 * `organizationId` is nullable on purpose: a request may come from someone who is not (or is no
 * longer) in any organization, and a request from a person we cannot place is still a request. It
 * is also how a request about CONTROLLER data is distinguished from one about a customer's own
 * tenant, where Alethia is a processor and the customer answers.
 */
export const privacyCase = pgTable(
	"privacy_case",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Short human reference, quoted in correspondence. Unique, and never reused. */
		reference: text().notNull().unique(),
		kind: privacyCaseKind().notNull(),
		state: privacyCaseState().default("received").notNull(),
		/** The subject, when they have an account. Null for a request from a non-account holder. */
		subjectUserId: uuid().references(() => user.id, { onDelete: "set null" }),
		/**
		 * SHA-256 of the lower-cased contact address the request came from.
		 *
		 * Hashed, not stored: it is the only identifier that survives fulfilment, and a table of
		 * plaintext addresses of everyone who ever exercised a right is itself a privacy problem —
		 * one that would be created by the machinery meant to solve it. Matching is by hash.
		 */
		subjectEmailSha256: text().notNull(),
		organizationId: uuid().references(() => organization.id, {
			onDelete: "set null",
		}),
		receivedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/**
		 * The statutory deadline. Stored, not computed at read time: the period is one month from
		 * receipt and can be extended once by two further months for a complex request — so the due
		 * date is a DECISION someone made, and recomputing it would erase that an extension was taken.
		 */
		dueAt: timestamp({ withTimezone: true }).notNull(),
		/** Set when the extension is taken, with the reason. Both, or neither. */
		extendedAt: timestamp({ withTimezone: true }),
		extensionReason: text(),
		/** Identity is verified BEFORE anything is disclosed or destroyed. */
		identityVerifiedAt: timestamp({ withTimezone: true }),
		/**
		 * Why fulfilment is blocked, when it is. A legal hold does not refuse the request — it pauses
		 * the part it covers, and the reason is disclosable to the subject.
		 */
		legalHoldReason: text(),
		decidedAt: timestamp({ withTimezone: true }),
		decidedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
		/** Required by law when refusing: the subject must be told WHY, and that they may complain. */
		refusalReason: text(),
		/** What the case covers and what was done — typed, never a loose record. */
		scope: jsonb().$type<PrivacyCaseScope>(),

		// ── Export artefacts (kind = export | access | portability) ──────────────────────────────
		/** Object-storage key of the generated archive. Null until one is produced. */
		exportObjectKey: text(),
		/** The signed manifest: what the archive contains, and its digest. */
		exportManifest: jsonb().$type<PrivacyExportManifest>(),
		/**
		 * When the download link stops working.
		 *
		 * An export is the most concentrated copy of a person's data this product ever makes. It is
		 * short-lived by design, and the expiry is enforced server-side at download rather than only
		 * by a signed URL's own lifetime — a URL that leaks is not recalled by its signature.
		 */
		exportExpiresAt: timestamp({ withTimezone: true }),

		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("privacy_case_subject_idx").on(t.subjectEmailSha256),
		index("privacy_case_state_idx").on(t.state),
		// The overdue query — "what is due and not decided?" — is the one that has to be fast, because
		// it is the one that runs on a schedule and produces the alert.
		index("privacy_case_due_idx").on(t.dueAt),
	],
);

export type PrivacyCase = typeof privacyCase.$inferSelect;
export type PrivacyCaseInsert = typeof privacyCase.$inferInsert;

/**
 * Append-only ledger of everything that happened on a case.
 *
 * Append-only in the strong sense: the WORM trigger in programmables.sql refuses UPDATE and DELETE.
 * A case's history is the evidence that the process was followed, and a history that can be edited
 * after the fact evidences nothing — including in our own favour.
 */
export const privacyCaseEvent = pgTable(
	"privacy_case_event",
	{
		id: uuid().primaryKey().defaultRandom(),
		caseId: uuid()
			.notNull()
			.references(() => privacyCase.id, { onDelete: "cascade" }),
		kind: privacyCaseEventKind().notNull(),
		at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/** Who did it. Null for an automated step, which is a real answer and not a missing one. */
		actorUserId: uuid().references(() => user.id, { onDelete: "set null" }),
		/** Structured detail. Typed; must never carry the subject's data back into the ledger. */
		detail: jsonb().$type<PrivacyEventDetail>().notNull(),
	},
	(t) => [index("privacy_case_event_case_idx").on(t.caseId, t.at)],
);

export type PrivacyCaseEvent = typeof privacyCaseEvent.$inferSelect;
export type PrivacyCaseEventInsert = typeof privacyCaseEvent.$inferInsert;

/**
 * What was erased, kept after the data is gone.
 *
 * THE RESTORE PROBLEM. Backups exist so that data survives; erasure exists so that it does not. A
 * restore replays the first against the second, and unless something outlives the erasure the
 * reinstated data looks exactly like data that was never erased. The tombstone is that something:
 * it holds no personal data itself, and a restore is not complete until it has been replayed.
 *
 * It is therefore NOT cascaded from the case, and NOT deleted when the user row goes. Its whole job
 * is to be the thing left behind.
 */
export const privacyErasureTombstone = pgTable(
	"privacy_erasure_tombstone",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** SHA-256 of the lower-cased address, matching privacy_case.subject_email_sha256. */
		subjectEmailSha256: text().notNull(),
		/**
		 * The user id that was erased. NOT a foreign key, deliberately: the row it pointed at is gone,
		 * and a constraint would either block the erasure or delete the tombstone with it — both of
		 * which defeat the purpose.
		 */
		erasedUserId: uuid(),
		/** The case that ordered it. Text, not an FK, for the same reason. */
		caseReference: text().notNull(),
		erasedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/** What was removed and what was pseudonymized instead. */
		scope: jsonb().$type<PrivacyCaseScope>().notNull(),
		/** Set when a restore replayed this tombstone. Null means: not yet re-applied after a restore. */
		replayedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("privacy_tombstone_subject_idx").on(t.subjectEmailSha256),
		index("privacy_tombstone_replayed_idx").on(t.replayedAt),
	],
);

export type PrivacyErasureTombstone = typeof privacyErasureTombstone.$inferSelect;
export type PrivacyErasureTombstoneInsert =
	typeof privacyErasureTombstone.$inferInsert;
