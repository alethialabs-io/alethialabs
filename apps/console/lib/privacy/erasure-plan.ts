// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What an erasure actually does, decided before anything is destroyed (#2373).
//
// "Delete my account" is not one operation. Some rows can go; some cannot go without breaking data
// that belongs to somebody else; and some must not go at all, because a legal obligation requires
// keeping them. Doing that reasoning inline, mid-transaction, is how a deletion either takes too
// much (breaking another tenant's records) or too little (quietly keeping what it said it removed).
//
// So the decision is a PURE FUNCTION over the register below, and the executor does what the plan
// says. That makes the hard part — which is legal, not technical — reviewable and testable without
// a database, and it makes the plan itself the thing we can show the subject.
//
// Three dispositions, and the middle one is the one people get wrong:
//
//   erase        the rows are the subject's, and nothing else depends on them.
//   pseudonymize the row must survive because ANOTHER party's record points at it — a support
//                thread they also participated in, an audit entry proving who approved what. The
//                identifier is replaced; the row stays coherent. Telling the subject this was
//                "deleted" would overstate it; omitting it would understate it.
//   retain       a legal obligation requires keeping it, and erasure does not override that
//                (GDPR art. 17(3)(b) and (e)). The subject is entitled to be told which, and why.

import type { PrivacyCaseScope } from "@/types/jsonb.types";

export type Disposition = "erase" | "pseudonymize" | "retain";

export interface ErasureRule {
	/** The Postgres table. */
	readonly table: string;
	/** The column carrying the subject's identity. */
	readonly subjectColumn: string;
	readonly disposition: Disposition;
	/**
	 * Why. Required for every rule and not only the awkward ones: a rule whose reason nobody wrote
	 * down is a rule nobody can review, and this register is the reviewable artefact.
	 */
	readonly reason: string;
	/** For `pseudonymize`: the columns to overwrite, and with what kind of placeholder. */
	readonly pseudonymize?: readonly { column: string; with: "redacted" | "null" }[];
}

/**
 * The erasure register.
 *
 * ⚠️ Ordering matters and is deliberate: `erase` rules run before `pseudonymize`, and both before
 * anything touches the `user` row itself, so a foreign key never blocks a step that a later step
 * would have made safe. The executor preserves this order rather than sorting.
 */
export const ERASURE_RULES: readonly ErasureRule[] = [
	{
		table: "agent_threads",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"AI conversations are the subject's own content and nothing else references them. They " +
			"also carry whatever the subject typed, which is the material most likely to be personal.",
	},
	{
		table: "profiles",
		subjectColumn: "id",
		disposition: "erase",
		reason: "The subject's own profile. Nothing outside their account depends on it.",
	},
	{
		table: "cli_logins",
		subjectColumn: "user_id",
		disposition: "erase",
		reason: "Device-authorisation records for the subject's own sessions.",
	},
	{
		table: "support_messages",
		subjectColumn: "author_user_id",
		disposition: "pseudonymize",
		reason:
			"A support thread belongs to everyone in it. Deleting one participant's messages removes " +
			"the other party's record of what they were told, so the author is unlinked and the " +
			"message body redacted instead.",
		pseudonymize: [
			{ column: "author_user_id", with: "null" },
			{ column: "body", with: "redacted" },
		],
	},
	{
		table: "audit_log",
		subjectColumn: "actor_user_id",
		disposition: "pseudonymize",
		reason:
			"The audit trail proves who approved what, and it protects the ORGANIZATION as much as it " +
			"records the individual. Removing the entries would destroy another party's evidence, so " +
			"the actor is unlinked and the entry kept.",
		pseudonymize: [{ column: "actor_user_id", with: "null" }],
	},
	{
		table: "authz_activity_log",
		subjectColumn: "actor_user_id",
		disposition: "pseudonymize",
		reason:
			"Authorization decisions answer 'who could have seen this?' — a question that outlives the " +
			"account and may be asked about a breach affecting other people. Unlinked, not removed. " +
			"Its own 365-day retention then expires it (see lib/retention/registry.ts).",
		pseudonymize: [{ column: "actor_user_id", with: "null" }],
	},
	{
		table: "legal_acceptance",
		subjectColumn: "user_id",
		disposition: "retain",
		reason:
			"Proof of which Terms version the account accepted, processed on a legal-obligation basis " +
			"(GDPR art. 17(3)(b)). Erasing it would destroy the only evidence of what was agreed — " +
			"including evidence that favours the subject in a dispute.",
	},
	{
		table: "commerce_order",
		subjectColumn: "placed_by_user_id",
		disposition: "retain",
		reason:
			"Orders and their tax records are kept for the statutory accounting period. Erasure does " +
			"not override a retention the law requires (GDPR art. 17(3)(b)).",
	},
	{
		table: "invoices",
		subjectColumn: "issued_to_user_id",
		disposition: "retain",
		reason:
			"Invoices are statutory accounting records for the same reason as the orders behind them.",
	},
];

/** A vendor that must be told to erase, because it holds a copy we sent it. */
export interface VendorErasure {
	readonly name: string;
	readonly holds: string;
	/** How erasure is requested. `manual` means a person has to do it — recorded, not pretended. */
	readonly method: "api" | "manual";
}

/**
 * Third parties holding a copy.
 *
 * GDPR art. 19 requires telling each recipient of the data about the erasure, so this is part of
 * the plan and not an afterthought. `manual` is an honest answer: a vendor with no erasure API means
 * a person does it, and the case ledger records when they did — which is better than an automated
 * step that quietly does nothing.
 */
export const VENDOR_ERASURES: readonly VendorErasure[] = [
	{
		name: "PostHog EU Cloud",
		holds: "Pseudonymous product-analytics events, for accounts that consented",
		method: "api",
	},
	{
		name: "Stripe Payments Europe, Ltd.",
		holds: "Billing contact and payment metadata for paid accounts",
		// Stripe retains transaction records under its own statutory obligations; what can be erased
		// is the contact detail, and that is a request rather than a call we make.
		method: "manual",
	},
	{
		name: "Amazon SES",
		holds: "Delivery metadata for transactional email",
		method: "manual",
	},
];

/** The plan for one subject: what will happen, in the order it will happen. */
export interface ErasurePlan {
	readonly erase: ErasureRule[];
	readonly pseudonymize: ErasureRule[];
	readonly retain: ErasureRule[];
	readonly vendors: readonly VendorErasure[];
	/** True when a legal hold blocks part of the plan. */
	readonly blocked: boolean;
	readonly blockedReason: string | null;
}

/**
 * Builds the plan.
 *
 * A LEGAL HOLD DOES NOT CANCEL THE REQUEST. It suspends the destructive half and leaves the rest —
 * so the subject still gets everything that can lawfully be done, and is told what is paused and
 * why. Treating a hold as a refusal would be both unlawful and, in practice, the easy shortcut.
 */
export function buildErasurePlan(opts: { legalHoldReason?: string | null } = {}): ErasurePlan {
	const hold = opts.legalHoldReason?.trim() || null;
	const by = (d: Disposition) => ERASURE_RULES.filter((r) => r.disposition === d);
	return {
		// Under a hold, nothing is destroyed or overwritten; the rules move to the retained side so
		// the plan still enumerates them and the subject can see what is paused.
		erase: hold ? [] : by("erase"),
		pseudonymize: hold ? [] : by("pseudonymize"),
		retain: hold ? [...ERASURE_RULES] : by("retain"),
		vendors: hold ? [] : VENDOR_ERASURES,
		blocked: hold !== null,
		blockedReason: hold,
	};
}

/**
 * The plan as the scope recorded on the case and, afterwards, on the tombstone.
 *
 * `notifiedAt` is a parameter for the same reason the manifest takes its timestamp: a value derived
 * from the wall clock cannot be asserted, and this one ends up in an append-only ledger.
 */
export function planToScope(plan: ErasurePlan, notifiedAt: Date): PrivacyCaseScope {
	return {
		erased: plan.erase.map((r) => r.table),
		pseudonymized: plan.pseudonymize.map((r) => ({
			table: r.table,
			reason: r.reason,
		})),
		retained: plan.retain.map((r) => ({ table: r.table, basis: r.reason })),
		vendors: plan.vendors.map((v) => ({
			name: v.name,
			notifiedAt: notifiedAt.toISOString(),
			// Confirmation is stamped when it arrives. Null is the honest state until then, and a
			// `manual` vendor may sit here for a while — which is exactly what should be visible.
			confirmedAt: null,
		})),
	};
}
