// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The handling steps of a data-subject request, WITHOUT the decision about who may take them.
//
// Two callers, two authorities, one implementation:
//
//   · `app/server/actions/privacy/cases.ts` — the console's server actions. Each one runs its
//     `authorizeCase` (a signed-in session with `org:edit` in the CASE's organization) and then
//     calls the step here with the actor that check produced.
//   · `app/api/internal/platform/privacy/**` — the staff app's routes (#7222). The staff app
//     authorizes its operator (Cloudflare Access + `PLATFORM_ADMIN_EMAILS`), audits the act, and
//     reaches the console with the operator-plane bearer; the route then calls the step here with
//     the operator's user id. That is the controller-level surface `cases.ts` names as missing.
//
// Splitting it this way is what keeps the two from drifting: the deadline arithmetic, the
// verified-before-destroyed rule, the single extension and the erasure transaction exist once. What
// lives here must therefore never take a decision about the CALLER — every function receives an
// actor that has already been authorized, and says so in its name for the case row it is handed.
//
// Not a `"use server"` module, deliberately: every export of one is a POST endpoint, and these take
// no authorization of their own. `server-only` makes importing it from a client bundle a build error.

import "server-only";
import { and, asc, desc, eq, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	newReference,
	recordEvent,
	subjectHash,
} from "@/app/server/actions/privacy/ledger";
import { PRIVACY_RESPONSE_DAYS as RESPONSE_DAYS } from "@/app/server/actions/privacy/response-period";
import { getServiceDb, type Tx } from "@/lib/db";
import {
	privacyCase,
	privacyCaseEvent,
	privacyErasureTombstone,
	user,
} from "@/lib/db/schema";
import { privacyCaseKind } from "@/lib/db/schema/enums";
import {
	applyErasurePlan,
	describeResidency,
	type ErasureResidency,
	type ErasureTableResult,
	findLiveResidency,
	residencyIsClear,
} from "@/lib/privacy/erasure-executor";
import { buildErasurePlan, planToScope } from "@/lib/privacy/erasure-plan";

/** The single extension available for a complex request, in days (two further months). */
const EXTENSION_DAYS = 60;

/** The shortest reason an extension or a legal hold may carry. */
const MIN_EXTENSION_REASON = 10;

/** The shortest grounds a refusal may carry: the reason AND the right to complain. */
const MIN_REFUSAL_REASON = 20;

/** The request kinds, from the enum the column is declared with. */
export const PRIVACY_CASE_KINDS = privacyCaseKind.enumValues;

/**
 * The shape of a reference, checked before it reaches a query.
 *
 * `newReference` mints `DSR-` and eight upper-case hex characters, so anything else is not a
 * reference this deployment ever issued and there is nothing to look up. Cheap, and it is the rule:
 * a reference is user input like any other.
 */
export const referenceSchema = z
	.string()
	.trim()
	.regex(/^DSR-[0-9A-F]{8}$/, "Not a privacy request reference.");

/**
 * A step declining to act, with a sentence written for the operator ("Identity is not verified…",
 * "only one extension is available"). Distinct from every other error so a caller can show THIS
 * message and nothing else: an unexpected failure — a database error — carries text nobody wrote for
 * a reader, and the staff route answers it with a generic sentence instead.
 */
export class PrivacyStepRefusal extends Error {
	override name = "PrivacyStepRefusal";
}

/**
 * Loads a case by reference, or null when nothing matches. Says nothing about who may act on it.
 *
 * A reference the schema rejects throws, because that is a malformed argument and not a lookup
 * that missed.
 */
export async function caseByReference(reference: string) {
	const [c] = await getServiceDb()
		.select()
		.from(privacyCase)
		.where(eq(privacyCase.reference, referenceSchema.parse(reference)))
		.limit(1);
	return c ?? null;
}

/** A case row, as the handling steps receive it. Inferred; there is no generated types file. */
export type PrivacyCaseRow = NonNullable<Awaited<ReturnType<typeof caseByReference>>>;

/** Refuses an extension reason too short to tell the subject why the request is complex. */
export function assertExtensionReason(reason: string): void {
	if (reason.trim().length < MIN_EXTENSION_REASON) {
		throw new PrivacyStepRefusal(
			"An extension must state why the request is complex — the subject has to be told.",
		);
	}
}

/** Refuses a legal-hold basis too short for the subject to be told what it is. */
export function assertHoldReason(reason: string): void {
	if (reason.trim().length < MIN_EXTENSION_REASON) {
		throw new PrivacyStepRefusal("A legal hold must state its basis — the subject is entitled to know it.");
	}
}

/** Refuses refusal grounds too short to carry the reason and the right to complain. */
export function assertRefusalReason(reason: string): void {
	if (reason.trim().length < MIN_REFUSAL_REASON) {
		throw new PrivacyStepRefusal(
			"A refusal must state its grounds. The subject has to be told why, and that they may " +
				"complain to the supervisory authority.",
		);
	}
}

/** What a new case records about who it concerns and how it arrived. */
export interface NewPrivacyCase {
	kind: (typeof PRIVACY_CASE_KINDS)[number];
	/** The address the request came from. Hashed here; never stored in the clear. */
	email: string;
	/** The account the request concerns, when one is known. */
	subjectUserId: string | null;
	/** The organization that raised it; null for a controller-level request. */
	organizationId: string | null;
	/** When the request was RECEIVED — the clock starts here, not when it was typed in. */
	receivedAt: Date;
	/** How it arrived, for the ledger's first line ("Request received", "Request received by email"). */
	receivedHow: string;
	/** Who recorded it. */
	actorUserId: string;
}

/**
 * Opens a case and starts the clock.
 *
 * `dueAt` is computed ONCE, here, and stored. Recomputing it at read time would look equivalent and
 * would erase the fact that an extension was taken — the extension is a decision someone made and
 * has to justify, not a property of the request.
 */
export async function insertPrivacyCase(input: NewPrivacyCase): Promise<{ reference: string }> {
	const reference = newReference();
	const [row] = await getServiceDb()
		.insert(privacyCase)
		.values({
			reference,
			kind: input.kind,
			subjectUserId: input.subjectUserId,
			subjectEmailSha256: subjectHash(input.email),
			organizationId: input.organizationId,
			receivedAt: input.receivedAt,
			dueAt: new Date(input.receivedAt.getTime() + RESPONSE_DAYS * 86_400_000),
		})
		.returning({ id: privacyCase.id });
	if (!row) throw new Error("Could not open the request.");

	await recordEvent(
		row.id,
		"received",
		{
			summary: `${input.receivedHow} (${input.kind}). Response due within ${RESPONSE_DAYS} days.`,
		},
		input.actorUserId,
	);
	return { reference };
}

/**
 * The account an address belongs to, or null. Matched case-insensitively, because an address
 * typed from an email header is not guaranteed to have the casing the account was created with.
 *
 * This LINKS a case to an account so the erasure has rows to match; it proves nothing about who
 * sent the request. Identity is a separate, recorded step and nothing destructive runs before it.
 */
export async function accountIdForEmail(email: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ id: user.id })
		.from(user)
		.where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
		.limit(1);
	return row?.id ?? null;
}

/** Marks identity verified on an already-authorized case. Nothing is disclosed or destroyed before. */
export async function markIdentityVerified(
	c: PrivacyCaseRow,
	actorUserId: string,
	now: Date,
): Promise<void> {
	await getServiceDb()
		.update(privacyCase)
		.set({ identityVerifiedAt: now, state: "in_review", updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"identity_verified",
		{ summary: "Identity verified; the request may now be acted on." },
		actorUserId,
	);
}

/**
 * Takes the single permitted extension on an already-authorized case.
 *
 * The reason is required and is disclosable: the subject must be told that the period was extended
 * AND why, so an extension with no stated reason is not a lawful extension.
 */
export async function extendCase(
	c: PrivacyCaseRow,
	actorUserId: string,
	reason: string,
	now: Date,
): Promise<{ dueAt: Date }> {
	assertExtensionReason(reason);
	if (c.extendedAt) {
		throw new PrivacyStepRefusal("This request has already been extended; only one extension is available.");
	}
	const dueAt = new Date(c.dueAt.getTime() + EXTENSION_DAYS * 86_400_000);
	await getServiceDb()
		.update(privacyCase)
		.set({ dueAt, extendedAt: now, extensionReason: reason.trim(), updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"note",
		{ summary: `Response period extended to ${dueAt.toISOString().slice(0, 10)}: ${reason.trim()}` },
		actorUserId,
	);
	return { dueAt };
}

/** Applies a legal hold to an already-authorized case. Pauses the destructive half; never refuses. */
export async function holdCase(
	c: PrivacyCaseRow,
	actorUserId: string,
	reason: string,
	now: Date,
): Promise<void> {
	assertHoldReason(reason);
	await getServiceDb()
		.update(privacyCase)
		.set({ legalHoldReason: reason.trim(), updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"legal_hold_applied",
		{ summary: `Legal hold applied: ${reason.trim()}. The request is paused, not refused.` },
		actorUserId,
	);
}

/**
 * Refuses an already-authorized case, with the reason the law requires.
 *
 * A refusal is a lawful outcome — but only with a reason, and only if the subject is told they may
 * complain to the supervisory authority. Both live in the recorded reason.
 */
export async function refuseCase(
	c: PrivacyCaseRow,
	actorUserId: string,
	reason: string,
	now: Date,
): Promise<void> {
	assertRefusalReason(reason);
	await getServiceDb()
		.update(privacyCase)
		.set({
			state: "refused",
			refusalReason: reason.trim(),
			decidedAt: now,
			decidedByUserId: actorUserId,
			updatedAt: now,
		})
		.where(eq(privacyCase.id, c.id));
	await recordEvent(c.id, "refused", { summary: `Refused: ${reason.trim()}` }, actorUserId);
}

/**
 * What one erasure step did. Three outcomes, and only one of them erased anything.
 *
 * A discriminated result rather than a thrown error for the two that did not: a refusal because the
 * subject's org is still running infrastructure is a NORMAL, expected answer that the caller has to
 * render to a person, and an exception is the wrong shape for an answer you were asked to give.
 */
export type ErasureFulfilment =
	| {
			outcome: "erased";
			/** Rows touched per table, in the register's order. */
			tables: ErasureTableResult[];
			rowsErased: number;
			rowsPseudonymized: number;
			/** Tables the register keeps, with a legal basis. Nothing was done to them. */
			tablesRetained: number;
	  }
	| { outcome: "paused_by_legal_hold"; reason: string }
	| {
			outcome: "refused_live_resources";
			/** The refusal in words, safe to show the subject verbatim. */
			message: string;
			residency: ErasureResidency;
	  };

/**
 * Applies `set` to the case only while it is undecided, inside the caller's transaction, and refuses
 * when that changed nothing — the case was decided after it was loaded, by a concurrent step.
 */
async function claimUndecided(
	tx: Tx,
	c: PrivacyCaseRow,
	set: Partial<typeof privacyCase.$inferInsert>,
): Promise<void> {
	const claimed = await tx
		.update(privacyCase)
		.set(set)
		.where(and(eq(privacyCase.id, c.id), isNull(privacyCase.decidedAt)))
		.returning({ id: privacyCase.id });
	if (claimed.length === 0) {
		throw new PrivacyStepRefusal(
			`Request ${c.reference} has already been decided; it takes no further step.`,
		);
	}
}

/**
 * Performs the erasure on an already-authorized case, and leaves the tombstone behind.
 *
 * Everything happens in ONE transaction with the tombstone and the ledger entry that describe it,
 * because a half-applied erasure is worse than none: the subject is told their data is gone while
 * some of it is not, and no record says which half.
 *
 * THE REFUSAL. When the subject's personal organization still has projects, undestroyed
 * environments or a connected cloud account, nothing is erased and the case stays open
 * (`in_review`, its deadline untouched). This is the maintainer's ruling of 2026-09-19: a personal
 * org's id IS the owner's user id, so erasing the owner would leave real cloud infrastructure
 * running with no account able to reach it, bill it or tear it down. This step never destroys a
 * resource and never transfers one, so the only safe answer is to say what is still there and wait.
 *
 * It is NOT a GDPR art. 12(5) refusal and does not set the case to `refused`: a refusal closes the
 * case and has to cite grounds and the right to complain. This is a step that has not been reached
 * yet, which is a different thing and is recorded as one.
 *
 * The tombstone is written EVEN under a legal hold, with an empty erasure scope: it records that the
 * request was made and what was held, so a later restore replays a decision that was actually taken.
 * It is NOT written for a live-resources refusal — nothing was erased, so there is nothing to replay.
 */
export async function performErasure(
	c: PrivacyCaseRow,
	actorUserId: string,
	now: Date,
): Promise<ErasureFulfilment> {
	if (!c.identityVerifiedAt) {
		throw new PrivacyStepRefusal(
			"Identity is not verified. Nothing is destroyed until we know who asked — an erasure " +
				"performed on an unverified request is itself a data breach.",
		);
	}
	if (c.kind !== "erasure") {
		throw new PrivacyStepRefusal(`Request ${c.reference} is a ${c.kind} request, not an erasure.`);
	}

	const plan = buildErasurePlan({ legalHoldReason: c.legalHoldReason });
	const scope = planToScope(plan, now);
	const db = getServiceDb();

	if (plan.blocked) {
		await db.transaction(async (tx) => {
			await tx.insert(privacyErasureTombstone).values({
				subjectEmailSha256: c.subjectEmailSha256,
				erasedUserId: c.subjectUserId,
				caseReference: c.reference,
				erasedAt: now,
				scope,
			});
			await claimUndecided(
				tx,
				c,
				{ scope, state: "in_review", updatedAt: now },
			);
			await recordEvent(
				c.id,
				"legal_hold_applied",
				{
					summary: `Erasure paused by a legal hold: ${plan.blockedReason}`,
					counts: { retained: plan.retain.length },
					tables: plan.retain.map((r) => r.table),
				},
				actorUserId,
				tx,
			);
		});
		return { outcome: "paused_by_legal_hold", reason: plan.blockedReason ?? "" };
	}

	// Every rule matches on an identifier. A case opened for someone with no account (the request
	// that arrives by email from a former user) has none, so there is nothing to match on and the
	// erasure is a manual one. Running the plan with a missing subject would delete nothing and
	// report success — the exact failure #4854 removed.
	if (!c.subjectUserId) {
		throw new PrivacyStepRefusal(
			`Request ${c.reference} names no account, so no row can be matched to the subject. It has ` +
				"to be fulfilled by hand and recorded on the case; this step would erase nothing and " +
				"report that it had.",
		);
	}
	// A personal organization's id IS the user's id, which is the whole reason erasing an owner
	// reaches an organization's resources at all.
	const subject = { userId: c.subjectUserId, personalOrgId: c.subjectUserId };

	return db.transaction(async (tx) => {
		const residency = await findLiveResidency(tx, subject);
		if (!residencyIsClear(residency)) {
			const message = describeResidency(residency);
			await tx
				.update(privacyCase)
				.set({ updatedAt: now })
				.where(eq(privacyCase.id, c.id));
			await recordEvent(
				c.id,
				"note",
				{
					summary: message,
					counts: {
						projects: residency.projects,
						environments_not_destroyed: residency.environments,
						cloud_connections: residency.cloudConnections,
						sole_owned_organizations: residency.soleOwnedOrganizations,
					},
				},
				actorUserId,
				tx,
			);
			return { outcome: "refused_live_resources", message, residency };
		}

		// The decision is taken FIRST, and only if nobody has taken it: two fulfils of one case — two
		// operators, a double click, a retried request — both loaded the case undecided, and without
		// this the second would run every statement again, write a second tombstone and a second
		// "Erasure performed". The UPDATE row-locks the case, so the second transaction waits for the
		// first, then finds `decided_at` set and changes nothing; it is refused and rolls back.
		await claimUndecided(tx, c, {
			scope,
			state: "fulfilled",
			decidedAt: now,
			decidedByUserId: actorUserId,
			updatedAt: now,
		});
		const execution = await applyErasurePlan(tx, plan, subject);
		await tx.insert(privacyErasureTombstone).values({
			subjectEmailSha256: c.subjectEmailSha256,
			erasedUserId: c.subjectUserId,
			caseReference: c.reference,
			erasedAt: now,
			scope,
		});
		await recordEvent(
			c.id,
			"erasure_performed",
			{
				summary:
					"Erasure performed. See the scope for what was removed, unlinked and retained, and " +
					"the counts for how many rows each half actually touched.",
				counts: {
					rows_erased: execution.rowsErased,
					rows_pseudonymized: execution.rowsPseudonymized,
					tables_erased: plan.erase.length,
					tables_pseudonymized: plan.pseudonymize.length,
					tables_retained: plan.retain.length,
				},
				tables: execution.tables.map((t) => t.table),
			},
			actorUserId,
			tx,
		);
		return {
			outcome: "erased",
			tables: execution.tables,
			rowsErased: execution.rowsErased,
			rowsPseudonymized: execution.rowsPseudonymized,
			tablesRetained: plan.retain.length,
		};
	});
}

/**
 * Requests still open past their deadline, within `scope` — the caller's standing, as a predicate.
 * `undefined` is the WHOLE deployment and is for the controller-level surface only.
 *
 * Overdue is measured against the STORED `dueAt`, which already accounts for any extension — so an
 * extended request is not reported late, and one that was never extended cannot be quietly treated
 * as if it had been.
 */
export async function queryOverdueCases(now: Date, scope: SQL | undefined) {
	return getServiceDb()
		.select({
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			dueAt: privacyCase.dueAt,
		})
		.from(privacyCase)
		.where(and(lt(privacyCase.dueAt, now), isNull(privacyCase.decidedAt), scope))
		.orderBy(privacyCase.dueAt);
}

/** The columns a controller-level list shows: the case's state, never the subject's address. */
const listColumns = {
	reference: privacyCase.reference,
	kind: privacyCase.kind,
	state: privacyCase.state,
	receivedAt: privacyCase.receivedAt,
	dueAt: privacyCase.dueAt,
	extendedAt: privacyCase.extendedAt,
	identityVerifiedAt: privacyCase.identityVerifiedAt,
	legalHoldReason: privacyCase.legalHoldReason,
	decidedAt: privacyCase.decidedAt,
	organizationId: privacyCase.organizationId,
	subjectUserId: privacyCase.subjectUserId,
};

/** How many decided cases the controller-level list shows, newest first. */
const RECENTLY_DECIDED_LIMIT = 50;

/**
 * EVERY undecided case in the deployment, soonest deadline first, and the most recently decided
 * ones. For the controller-level surface only — it has no scope, by design: the platform-admin
 * route that calls it is where the controller's authority is checked.
 */
export async function queryControllerCaseList() {
	const db = getServiceDb();
	const [open, decided] = await Promise.all([
		db
			.select(listColumns)
			.from(privacyCase)
			.where(isNull(privacyCase.decidedAt))
			.orderBy(asc(privacyCase.dueAt)),
		db
			.select(listColumns)
			.from(privacyCase)
			.where(isNotNull(privacyCase.decidedAt))
			.orderBy(desc(privacyCase.decidedAt))
			.limit(RECENTLY_DECIDED_LIMIT),
	]);
	return { open, decided };
}

/**
 * A case's ledger with each actor's address beside it, oldest first — for the controller-level
 * surface, whose readers are the staff who wrote it. The console's subject-facing history
 * ({@link caseEvents}) does not name actors.
 */
export async function caseEventsWithActors(c: PrivacyCaseRow) {
	return getServiceDb()
		.select({
			kind: privacyCaseEvent.kind,
			at: privacyCaseEvent.at,
			summary: sql<string>`${privacyCaseEvent.detail}->>'summary'`,
			actorEmail: user.email,
		})
		.from(privacyCaseEvent)
		.leftJoin(user, eq(user.id, privacyCaseEvent.actorUserId))
		.where(eq(privacyCaseEvent.caseId, c.id))
		.orderBy(privacyCaseEvent.at);
}

/** Whether a user id names an account — a ledger actor must be one (the column is a foreign key). */
export async function userExists(userId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: user.id })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return Boolean(row);
}

/** A case's full ledger, oldest first — the evidence that the process was followed. */
export async function caseEvents(c: PrivacyCaseRow) {
	return getServiceDb()
		.select()
		.from(privacyCaseEvent)
		.where(eq(privacyCaseEvent.caseId, c.id))
		.orderBy(privacyCaseEvent.at);
}
