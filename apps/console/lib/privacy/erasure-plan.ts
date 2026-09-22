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
//
// ⚠️ EVERY TABLE AND COLUMN NAMED HERE IS CHECKED AGAINST THE DRIZZLE SCHEMA by
// `tests/privacy/erasure-register-schema.test.ts`, and the placeholder each pseudonymize column
// takes is checked against that column's nullability and type. Before #4854 nothing did, and four
// of the nine rules named something that does not exist: `invoices.issued_to_user_id` (the table is
// `invoice`, org-scoped, with no user column at all), `support_messages.author_user_id` (the column
// is `author_id`), `cli_logins.user_id` (it is `profile_id`), and `audit_log.actor_user_id` /
// `authz_activity_log.actor_user_id` (both are the subject's id under another name, and both are
// NOT NULL, so the `null` placeholder they asked for could not have been written either). A
// register that names columns which do not exist reads exactly like one that does — which is how it
// sat beside an executor that erased nothing for long enough for the two to agree.
//
// It is NOT claimed to be exhaustive over the schema. It is the set of tables someone has decided
// about; a table absent from it has been decided about by nobody, which is why the executor reports
// what it touched rather than claiming to have erased "the account".

import type { PrivacyCaseScope } from "@/types/jsonb.types";

export type Disposition = "erase" | "pseudonymize" | "retain";

/**
 * What a pseudonymized column is overwritten WITH.
 *
 * Four kinds and not one, because the column constraints decide: `null` needs a nullable column,
 * and three columns in this register are NOT NULL. Writing the wrong one is a runtime error inside
 * the erasure transaction — which is why the kind is checked against the real column.
 *
 *   null          the column is nullable; the link is simply removed.
 *   redacted      a text column whose CONTENT is the personal data (a message body). Replaced with
 *                 a fixed marker, so the row still reads as "a message was here".
 *   nil_uuid      a NOT NULL uuid carrying the subject's id and no foreign key. The all-zero uuid
 *                 is a value no account can ever have, so the row is unlinked without being lost.
 *   erased_email  `user.email` — NOT NULL and UNIQUE. A fixed marker would collide on the second
 *                 erasure, so this one is generated per erasure, in a reserved-for-invalid domain
 *                 (RFC 2606 `.invalid`) that can never be delivered to or signed in with.
 */
export type Placeholder = "null" | "redacted" | "nil_uuid" | "erased_email";

/** The fixed marker written into a redacted text column. */
export const REDACTED_MARKER = "[erased]";

/** The all-zero uuid: a value no account can hold, so it cannot silently re-link to a person. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * WHICH identifier the subject column holds.
 *
 * A personal organization's id IS the user's id, so at execution time both bind the same value.
 * They are still distinguished, because they are different CLAIMS about the row: `user` says the
 * row is the person's, `personal_org` says the row belongs to the tenant they happen to be alone
 * in. `invoice` is the one that matters — it is org-scoped, and a register that called its
 * `organization_id` a user column would be describing a different table.
 */
export type SubjectKey = "user" | "personal_org";

export interface ErasureRule {
	/** The Postgres table. */
	readonly table: string;
	/** The column carrying the subject's identity. */
	readonly subjectColumn: string;
	/** What that column holds. Defaults to the subject's user id when omitted. */
	readonly subject?: SubjectKey;
	readonly disposition: Disposition;
	/**
	 * Why. Required for every rule and not only the awkward ones: a rule whose reason nobody wrote
	 * down is a rule nobody can review, and this register is the reviewable artefact.
	 */
	readonly reason: string;
	/** For `pseudonymize`: the columns to overwrite, and with what kind of placeholder. */
	readonly pseudonymize?: readonly { column: string; with: Placeholder }[];
	/**
	 * For a `pseudonymize` rule that does NOT overwrite its own subject column: why the key survives.
	 *
	 * Exactly one rule needs this — `user`, whose subject column is the primary key that every
	 * retained record points at. Overwriting it would break the statutory records the register keeps
	 * on purpose; what is erased there is the row's CONTENT. Required rather than inferred, because
	 * "the identifier was left in place" is the failure mode this register exists to make visible.
	 */
	readonly keyRetainedBecause?: string;
}

/**
 * The erasure register.
 *
 * ⚠️ Ordering matters and is deliberate. Two orderings are load-bearing and both are enforced by
 * the executor preserving this array rather than sorting it:
 *
 *   · `erase` runs before `pseudonymize`, and the `user` rule is last, so a foreign key never
 *     blocks a step a later step would have made safe.
 *   · WITHIN `erase`, a child goes before its parent where the reference has no `ON DELETE`:
 *     `oauth_access_token.refresh_id` → `oauth_refresh_token`, and `cli_logins.profile_id` →
 *     `profiles`. The register had `profiles` BEFORE `cli_logins`, which would have failed on the
 *     foreign key the first time it ran on a subject who had ever used `alethia login`.
 */
export const ERASURE_RULES: readonly ErasureRule[] = [
	// ── erase ────────────────────────────────────────────────────────────────────────────────────
	{
		table: "agent_threads",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"AI conversations are the subject's own content and nothing else references them. They " +
			"also carry whatever the subject typed, which is the material most likely to be personal.",
	},
	{
		table: "oauth_access_token",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"A live access token is a credential that speaks for the account. Leaving one behind means " +
			"the erased account can still act, which is a security defect before it is a privacy one. " +
			"Erased BEFORE oauth_refresh_token: refresh_id points at it with no ON DELETE.",
	},
	{
		table: "oauth_refresh_token",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"A refresh token mints new access tokens for the account indefinitely, so it outlives every " +
			"access token erased above and has to go with them.",
	},
	{
		table: "oauth_consent",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"The subject's own record of which client they authorised. It grants nothing to anyone " +
			"else, and a consent that survives its account would re-authorise a client on a re-signup.",
	},
	{
		table: "session",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"Browser sessions are the subject's own, and each carries the IP address and user agent it " +
			"was created from — personal data in its own right, not only a way back into the account.",
	},
	{
		table: "account",
		subjectColumn: "user_id",
		disposition: "erase",
		reason:
			"The linked social/git identities and the provider OAuth tokens and password hash behind " +
			"them. Nothing outside the account reads these, and they are the most sensitive rows it has.",
	},
	{
		table: "cli_logins",
		subjectColumn: "profile_id",
		disposition: "erase",
		reason:
			"Device-authorisation records for the subject's own sessions, carrying the request IP and " +
			"whatever the CLI said about the machine. Erased BEFORE profiles: profile_id references it " +
			"with no ON DELETE, so the other order fails on the foreign key.",
	},
	{
		table: "profiles",
		subjectColumn: "id",
		disposition: "erase",
		reason:
			"The subject's own profile — their email, name and avatar. Nothing outside their account " +
			"depends on it, and one thing depends on it going: cli_service_tokens.created_by " +
			"references this row ON DELETE SET NULL, and verifyCliToken (lib/cli/auth.ts) REFUSES a " +
			"token whose minting profile is gone. So erasing this row revokes every service token the " +
			"subject ever minted, which is why the register does not list that table — the credential " +
			"dies here, and the token row survives as the audit record its schema comment asks for.",
	},

	// ── pseudonymize ─────────────────────────────────────────────────────────────────────────────
	{
		table: "support_messages",
		subjectColumn: "author_id",
		disposition: "pseudonymize",
		reason:
			"A support thread belongs to everyone in it. Deleting one participant's messages removes " +
			"the other party's record of what they were told, so the author is unlinked and the " +
			"message body redacted instead. author_name is a display-label SNAPSHOT — the subject's " +
			"name in plaintext — so unlinking author_id without it would leave the name behind.",
		pseudonymize: [
			{ column: "author_id", with: "null" },
			{ column: "author_name", with: "null" },
			{ column: "body", with: "redacted" },
		],
	},
	{
		table: "audit_log",
		subjectColumn: "user_id",
		disposition: "pseudonymize",
		reason:
			"The audit trail proves who approved what, and it protects the ORGANIZATION as much as it " +
			"records the individual. Removing the entries would destroy another party's evidence, so " +
			"the actor is unlinked and the entry kept. The column is NOT NULL and carries no foreign " +
			"key, so the nil uuid is the unlink — a value no account can hold.",
		pseudonymize: [{ column: "user_id", with: "nil_uuid" }],
	},
	{
		table: "oauth_client",
		subjectColumn: "user_id",
		disposition: "pseudonymize",
		reason:
			"An OAuth client the subject registered may be in use by other people, and deleting it " +
			"would break their integrations and orphan their tokens. What is personal is the " +
			"registrant link, so that is unlinked and the client left working.",
		pseudonymize: [{ column: "user_id", with: "null" }],
	},
	{
		table: "user",
		subjectColumn: "id",
		disposition: "pseudonymize",
		reason:
			"THE ACCOUNT ROW ITSELF. It is not deleted, and could not be: legal_acceptance cascades " +
			"from it, so deleting the user would destroy the very acceptance record this register " +
			"retains under GDPR art. 17(3)(b), and commerce_order references it ON DELETE RESTRICT, so " +
			"the delete would be refused by Postgres anyway. Both constraints are correct and stay. " +
			"What is erased is the row's CONTENT — the address, the name, the avatar and the provider " +
			"handle — which is every personal datum the row holds.",
		pseudonymize: [
			{ column: "email", with: "erased_email" },
			{ column: "name", with: "null" },
			{ column: "image", with: "null" },
			{ column: "username", with: "null" },
		],
		keyRetainedBecause:
			"The primary key is a surrogate with no personal content, and it is what the retained " +
			"statutory records (legal_acceptance, commerce_order) point at. Overwriting it would " +
			"detach the records this register keeps on purpose; with the row's content erased, the id " +
			"resolves to nobody and is pseudonymous by construction.",
	},

	// ── retain ───────────────────────────────────────────────────────────────────────────────────
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
			"not override a retention the law requires (GDPR art. 17(3)(b)). Its ON DELETE RESTRICT " +
			"reference to the user is what makes that retention true rather than merely intended.",
	},
	{
		table: "invoice",
		subjectColumn: "organization_id",
		subject: "personal_org",
		disposition: "retain",
		reason:
			"Invoices are statutory accounting records for the same reason as the orders behind them " +
			"(GDPR art. 17(3)(b)). ORG-SCOPED, not user-scoped: the table has no user column, so the " +
			"subject's invoices are the ones issued to their personal organization — whose id is their " +
			"user id. An org with other members is a different controller question and is not this row.",
	},
	{
		table: "authz_activity_log",
		subjectColumn: "actor_id",
		disposition: "retain",
		reason:
			"Authorization decisions answer 'who could have seen this?' — a question that outlives the " +
			"account and may be asked about a breach affecting other people, so it is kept on the " +
			"legal-obligation and legal-claims grounds of GDPR art. 17(3)(b) and (e). It CANNOT be " +
			"pseudonymized in place even if we wanted to: the WORM trigger in programmables.sql " +
			"refuses every UPDATE, for every role, and actor_id is NOT NULL. Its own 365-day retention " +
			"GC expires the row instead (see lib/retention/registry.ts).",
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
