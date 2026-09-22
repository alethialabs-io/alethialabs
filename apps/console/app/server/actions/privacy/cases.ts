"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Handling a data-subject request as a process with a record (#2373).
//
// The runbook this replaces described a good process; what it could not do is DEMONSTRATE one. So
// every step here writes to the append-only ledger, and the things that matter legally are enforced
// rather than remembered:
//
//   · the clock starts at receipt and the deadline is stored, not recomputed;
//   · nothing is disclosed or destroyed before identity is verified;
//   · a refusal must carry a reason, because the subject is entitled to one;
//   · a legal hold pauses the destructive half — it never converts the request into a refusal.
//
// THE GATE IS ABOUT THE CASE, NOT ABOUT THE CALLER'S OWN ORG (#4854). Every handling step used to
// open with `authorize("edit", { type: "org" })` and then load ANY case by reference on the
// service connection. That reads like a gate and is not one: `authorize` with no resource id
// enforces the verb in the caller's own AMBIENT scope, every account has a personal organization
// whose id is its user id, and the built-in owner role holds `"*"` over it. So the check was
// satisfied by every signed-in user, for their own org, and then the action acted on a case that
// had nothing to do with it. While `fulfilErasure` deleted nothing that was a disclosure bug; with
// an executor behind it, it is "any account may destroy any other account's data by quoting a
// reference". See {@link authorizeCase} for what replaced it and what each ground proves.
//
// The residual gap is named rather than papered over: a case that belongs to NO ORGANIZATION —
// the request that arrives by email from a former user, and equally every self-serve request,
// because a personal org is recorded as none — has no console authority that can decide it. Those
// reach the controller directly, and the platform-admin surface for them is `apps/admin`, behind
// Cloudflare Access and `PLATFORM_ADMIN_EMAILS`. It is not built here, so these steps refuse such
// a case instead of admitting whoever asked — including the subject, who may read their own case
// and decide nothing on it. See {@link authorizeCase} for why the subject is not the second party.
//
// Every write goes through getServiceDb: the tables are service-role only (RLS with no app policy),
// because a case may concern someone who is in no organization at all and an owner-scoped policy
// would either leak those rows to a tenant or hide a person's case from the only path that can
// answer it.

import { and, desc, eq, getTableColumns, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	privacyCase,
	privacyCaseEvent,
	privacyErasureTombstone,
} from "@/lib/db/schema";
import type { PrivacyCaseKind } from "@/lib/db/schema/enums";
import {
	applyErasurePlan,
	describeResidency,
	type ErasureResidency,
	type ErasureTableResult,
	findLiveResidency,
	residencyIsClear,
} from "@/lib/privacy/erasure-executor";
import { buildErasurePlan, planToScope } from "@/lib/privacy/erasure-plan";
import { newReference, recordEvent, subjectHash } from "./ledger";
import { PRIVACY_RESPONSE_DAYS as RESPONSE_DAYS } from "./response-period";

/** The single extension available for a complex request, in days (two further months). */
const EXTENSION_DAYS = 60;

const openSchema = z.object({
	kind: z.enum([
		"access",
		"export",
		"rectification",
		"erasure",
		"restriction",
		"objection",
		"portability",
	]),
	/** The address the request came from. Hashed on the way in; never stored in the clear. */
	email: z.string().email(),
	/** Anything the subject said, kept for context. Never used as an identity check. */
	note: z.string().trim().max(2000).nullable().default(null),
});

export type OpenPrivacyCaseInput = z.input<typeof openSchema>;

/**
 * Opens a case and starts the clock.
 *
 * `dueAt` is computed ONCE, here, and stored. Recomputing it at read time would look equivalent and
 * would erase the fact that an extension was taken — the extension is a decision someone made and
 * has to justify, not a property of the request.
 */
export async function openPrivacyCase(
	input: OpenPrivacyCaseInput,
	now = new Date(),
): Promise<{ reference: string }> {
	const parsed = openSchema.parse(input);
	const actor = await currentActor();
	const reference = newReference();

	const [row] = await getServiceDb()
		.insert(privacyCase)
		.values({
			reference,
			kind: parsed.kind,
			subjectUserId: actor.userId,
			subjectEmailSha256: subjectHash(parsed.email),
			organizationId:
				actor.orgId && actor.orgId !== actor.userId ? actor.orgId : null,
			receivedAt: now,
			dueAt: new Date(now.getTime() + RESPONSE_DAYS * 86_400_000),
		})
		.returning({ id: privacyCase.id });
	if (!row) throw new Error("Could not open the request.");

	await recordEvent(
		row.id,
		"received",
		{
			summary: `Request received (${parsed.kind}). Response due within ${RESPONSE_DAYS} days.`,
		},
		actor.userId,
	);
	return { reference };
}

/**
 * Marks identity verified. Nothing is disclosed or destroyed before this.
 *
 * Deliberately a separate, privileged step rather than something `openPrivacyCase` infers: a request
 * arriving from a signed-in session is good evidence, but the requests that matter most are the ones
 * that do not — from a former account, or from an address we cannot place — and a code path that
 * verifies implicitly would have no way to handle those. The one case that arrives verified is the
 * account dialog's own erasure request (`requestMyErasure`, `self-serve.ts`): a separate entry point
 * that takes no subject from its caller and records in the ledger that the session was the check.
 */
export async function verifyPrivacyCaseIdentity(
	reference: string,
	now = new Date(),
): Promise<void> {
	const { actor, c } = await authorizeCase(reference);
	await getServiceDb()
		.update(privacyCase)
		.set({ identityVerifiedAt: now, state: "in_review", updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"identity_verified",
		{ summary: "Identity verified; the request may now be acted on." },
		actor.userId,
	);
}

/**
 * The shape of a reference, checked before it reaches a query.
 *
 * `newReference` mints `DSR-` and eight upper-case hex characters, so anything else is not a
 * reference this deployment ever issued and there is nothing to look up. Cheap, and it is the rule:
 * a reference is user input to a server action like any other.
 */
const referenceSchema = z
	.string()
	.trim()
	.regex(/^DSR-[0-9A-F]{8}$/, "Not a privacy request reference.");

/**
 * Loads a case by reference, or null when nothing matches. Says nothing about who may act on it.
 *
 * Null rather than a throw so {@link authorizeCase} can answer "no such reference" and "not yours"
 * identically; a reference the schema rejects still throws, because that is a malformed argument
 * and not a lookup that missed.
 */
async function caseByReference(reference: string) {
	const [c] = await getServiceDb()
		.select()
		.from(privacyCase)
		.where(eq(privacyCase.reference, referenceSchema.parse(reference)))
		.limit(1);
	return c ?? null;
}

/** A case row, as the handling steps receive it. Inferred; there is no generated types file. */
type PrivacyCaseRow = NonNullable<Awaited<ReturnType<typeof caseByReference>>>;

/**
 * Loads the case a handling step names AND proves the caller has standing over THAT case.
 *
 * This is the whole authorization decision for `cases.ts`, in one place because it used to be in
 * six — five of them a gate that proved nothing, and `privacyCaseHistory` no gate at all (#4854).
 * What the five had — `authorize("edit", { type:
 * "org" })` — enforces `org:edit` in the caller's OWN ambient scope. Every account owns a personal
 * organization (its id IS the user id) and the built-in `owner` role is `"*"`, so that call
 * succeeds for every signed-in user and says nothing whatever about the case the next line then
 * loads by reference, cross-tenant, on the RLS-bypassing service connection.
 *
 * THE CONTROLLER GROUND, which every step that RECORDS A DECISION requires: `org:edit` in
 * `case.organizationId` — the case's org, not the caller's. {@link authorizeInOrg} refuses a
 * substituted org rather than enforcing the verb wherever the session happens to point (#3863),
 * which is what makes this a statement about the named org rather than about the caller's default
 * one.
 *
 * THE SUBJECT GROUND, `actor.userId === case.subjectUserId`, is OFF by default and exactly one
 * caller turns it on: `privacyCaseHistory`, which shows a person their own case. It is off
 * everywhere else because every other step here writes a CONTROLLER'S decision into an append-only
 * ledger — the identity check, the extension, the hold, the refusal and the erasure itself. A
 * subject recording any of those about themselves is a second party that never existed, and for
 * `fulfilErasure` it is worse than that: this module is `"use server"`, so the step is a POST
 * endpoint whether or not the product calls it (nothing does), and `requestMyErasure` hands the
 * browser a reference to a case it has already marked identity-verified. Admitting the subject
 * there would make an irreversible erasure reachable in ONE unconfirmed POST — with no
 * confirmation dialog, no `destructive-actions.yaml` row and no e2e coverage, while
 * `account-settings-dialog.tsx` promises the opposite in as many words.
 *
 * ⚠️ THE CONSEQUENCE, STATED RATHER THAN DISCOVERED: a case with NO organization — which is every
 * self-serve request, because a personal org is recorded as none — can now be decided by nobody in
 * the console. That is the same residual gap the module header names, reached from the other side:
 * those are controller-level requests, and the controller's surface is `apps/admin`. An erasure
 * that needs a second party and has none is refused, not quietly performed by the first.
 *
 * Anything else is refused, INCLUDING a reference that matches no case: the answers are one
 * `ForbiddenError` with one message on purpose, so enumerating references cannot tell a caller
 * with no standing which of them exist. An operator's typo pays a worse message for that; a
 * reference is quoted in correspondence, and correspondence is forwarded. ⚠️ The MESSAGES are
 * uniform; the LATENCY is not — the org ground costs two further queries before it refuses, so a
 * caller timing the two can still tell them apart. Closing that needs a constant-time path this
 * does not have, and saying otherwise would claim a property the code lacks.
 *
 * AND ONLY FROM A BROWSER SESSION. An actor injected by `runWithActor` — the MCP / API-token path
 * — is refused before either ground is considered, the same rule `requestMyErasure` applies for
 * the same reason: the maintainer's ruling on #4273 is that an authenticated console SESSION meets
 * the identity bar for acting on a person's privacy case, and it says nothing about a machine
 * credential, so a token does not inherit it. Stated once here rather than left to fall out of
 * `authorizeInOrg` reading the session — that would refuse a token on the tenant ground by
 * accident while the subject ground admitted it.
 *
 * It does NOT re-check identity verification, the case kind or a legal hold — those are the
 * caller's own preconditions and each step states its own.
 */
async function authorizeCase(
	reference: string,
	{ subjectMayAct = false }: { subjectMayAct?: boolean } = {},
): Promise<{ actor: Actor; c: PrivacyCaseRow }> {
	if (getInjectedActor()) {
		throw new ForbiddenError(
			"edit",
			{ type: "org" },
			"a privacy request is acted on from a signed-in console session, not by a machine credential",
		);
	}
	// The session first, and the lookup second: an unauthenticated caller is turned away before a
	// reference reaches the database at all.
	const actor = await currentActor();
	const c = await caseByReference(reference);
	if (subjectMayAct && c && c.subjectUserId && c.subjectUserId === actor.userId) {
		return { actor, c };
	}
	if (c?.organizationId) {
		try {
			return {
				actor: await authorizeInOrg(
					"edit",
					{ type: "org", id: c.organizationId },
					c.organizationId,
				),
				c,
			};
		} catch (err) {
			// Rethrown as THIS module's refusal, not the guard's. `authorizeInOrg`'s own
			// ForbiddenError says "not scoped to organization <id>" and carries the case's
			// organization id — which is a fact about a case the caller has just been told it may
			// not see. Only a ForbiddenError is converted: a database failure inside the guard must
			// keep propagating as an error rather than being reported as a denial.
			if (!(err instanceof ForbiddenError)) throw err;
		}
	}
	throw new ForbiddenError(
		"edit",
		{ type: "org" },
		"this privacy request is not yours to decide; a controller-level request is handled " +
			"through the platform-admin surface, not the console",
	);
}

/**
 * Takes the single permitted extension.
 *
 * The reason is required and is disclosable: the subject must be told that the period was extended
 * AND why, so an extension with no stated reason is not a lawful extension. Refusing to record one
 * without a reason is the cheapest way to make that true.
 */
export async function extendPrivacyCase(
	reference: string,
	reason: string,
	now = new Date(),
): Promise<{ dueAt: Date }> {
	if (reason.trim().length < 10) {
		throw new Error(
			"An extension must state why the request is complex — the subject has to be told.",
		);
	}
	const { actor, c } = await authorizeCase(reference);
	if (c.extendedAt) {
		throw new Error("This request has already been extended; only one extension is available.");
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
		actor.userId,
	);
	return { dueAt };
}

/** Applies a legal hold. Pauses the destructive half; never refuses the request. */
export async function holdPrivacyCase(
	reference: string,
	reason: string,
	now = new Date(),
): Promise<void> {
	if (reason.trim().length < 10) {
		throw new Error("A legal hold must state its basis — the subject is entitled to know it.");
	}
	const { actor, c } = await authorizeCase(reference);
	await getServiceDb()
		.update(privacyCase)
		.set({ legalHoldReason: reason.trim(), updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"legal_hold_applied",
		{ summary: `Legal hold applied: ${reason.trim()}. The request is paused, not refused.` },
		actor.userId,
	);
}

/**
 * What one call to {@link fulfilErasure} did. Three outcomes, and only one of them erased anything.
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
 * Performs the erasure, and leaves the tombstone behind.
 *
 * Until #4854 this function built a plan, wrote a tombstone, set the case to `fulfilled` and
 * recorded "Erasure performed" — and never deleted or overwrote a single row. Everything it does
 * now happens in ONE transaction with the tombstone and the ledger entry that describe it, because
 * a half-applied erasure is worse than none: the subject is told their data is gone while some of
 * it is not, and no record says which half.
 *
 * THE REFUSAL. When the subject's personal organization still has projects, undestroyed
 * environments or a connected cloud account, nothing is erased and the case stays open
 * (`in_review`, its deadline untouched). This is the maintainer's ruling of 2026-09-19 and it is a
 * feature: a personal org's id IS the owner's user id, so erasing the owner would leave real cloud
 * infrastructure running with no account able to reach it, bill it or tear it down. This step never
 * destroys a resource and never transfers one to somebody else, so the only safe answer is to say
 * what is still there and wait. The ledger records the refusal and its counts, so a subject asking
 * why is answered from the case rather than from memory.
 *
 * It is NOT a GDPR art. 12(5) refusal and does not set the case to `refused`: a refusal closes the
 * case and has to cite grounds and the right to complain. This is a step that has not been reached
 * yet, which is a different thing and is recorded as one.
 *
 * The tombstone is written EVEN under a legal hold, with an empty erasure scope. That looks odd and
 * is deliberate: it records that the request was made and what was held, so a later restore replays
 * a decision that was actually taken rather than finding no trace of one. It is NOT written for a
 * live-resources refusal — nothing was erased, so there is nothing for a restore to replay, and a
 * tombstone recording an erasure that did not happen is the false record this issue is about.
 */
export async function fulfilErasure(
	reference: string,
	now = new Date(),
): Promise<ErasureFulfilment> {
	const { actor, c } = await authorizeCase(reference);
	if (!c.identityVerifiedAt) {
		throw new Error(
			"Identity is not verified. Nothing is destroyed until we know who asked — an erasure " +
				"performed on an unverified request is itself a data breach.",
		);
	}
	if (c.kind !== "erasure") {
		throw new Error(`Request ${reference} is a ${c.kind} request, not an erasure.`);
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
			await tx
				.update(privacyCase)
				.set({ scope, state: "in_review", updatedAt: now })
				.where(eq(privacyCase.id, c.id));
			await recordEvent(
				c.id,
				"legal_hold_applied",
				{
					summary: `Erasure paused by a legal hold: ${plan.blockedReason}`,
					counts: { retained: plan.retain.length },
					tables: plan.retain.map((r) => r.table),
				},
				actor.userId,
				tx,
			);
		});
		return { outcome: "paused_by_legal_hold", reason: plan.blockedReason ?? "" };
	}

	// Every rule matches on an identifier. A case opened by someone with no account (the request
	// that arrives by email from a former user) has none, so there is nothing to match on and the
	// erasure is a manual one. Running the plan with a missing subject would delete nothing and
	// report success — the exact failure this issue exists to remove.
	if (!c.subjectUserId) {
		throw new Error(
			`Request ${reference} names no account, so no row can be matched to the subject. It has ` +
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
				actor.userId,
				tx,
			);
			return { outcome: "refused_live_resources", message, residency };
		}

		const execution = await applyErasurePlan(tx, plan, subject);
		await tx.insert(privacyErasureTombstone).values({
			subjectEmailSha256: c.subjectEmailSha256,
			erasedUserId: c.subjectUserId,
			caseReference: c.reference,
			erasedAt: now,
			scope,
		});
		await tx
			.update(privacyCase)
			.set({
				scope,
				state: "fulfilled",
				decidedAt: now,
				decidedByUserId: actor.userId,
				updatedAt: now,
			})
			.where(eq(privacyCase.id, c.id));
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
			actor.userId,
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
 * Refuses a request, with the reason the law requires.
 *
 * A refusal is a lawful outcome — but only with a reason, and only if the subject is told they may
 * complain to the supervisory authority. Both live in the recorded reason, so a refusal cannot be
 * entered without them.
 */
export async function refusePrivacyCase(
	reference: string,
	reason: string,
	now = new Date(),
): Promise<void> {
	if (reason.trim().length < 20) {
		throw new Error(
			"A refusal must state its grounds. The subject has to be told why, and that they may " +
				"complain to the supervisory authority.",
		);
	}
	const { actor, c } = await authorizeCase(reference);
	await getServiceDb()
		.update(privacyCase)
		.set({
			state: "refused",
			refusalReason: reason.trim(),
			decidedAt: now,
			decidedByUserId: actor.userId,
			updatedAt: now,
		})
		.where(eq(privacyCase.id, c.id));
	await recordEvent(c.id, "refused", { summary: `Refused: ${reason.trim()}` }, actor.userId);
}

/**
 * Requests still open past their deadline, BOUNDED BY WHAT THE CALLER HAS STANDING OVER.
 *
 * Overdue is measured against the STORED `dueAt`, which already accounts for any extension — so an
 * extended request is not reported late, and one that was never extended cannot be quietly treated
 * as if it had been.
 *
 * It took no argument and had no gate at all before #4854 — and every export of a `"use server"`
 * module is a POST endpoint whether or not anything in the product calls it, so this one answered
 * every open case in the deployment, across every tenant, to anyone who asked. It now requires
 * `org:edit` and returns only the cases that org raised plus the caller's own. The verb matches
 * {@link authorizeCase}'s deliberately: `org:view` is held by every viewer in the organization,
 * and "who here has an open privacy request" is not a viewer's business — the bar for a row is the
 * same whether it is read one at a time or in a list. A controller-wide list is not
 * available from the console and is not made available here: that is the platform-admin surface,
 * and alerting that needs the whole deployment reads the database directly.
 */
export async function overduePrivacyCases(now = new Date()) {
	const actor = await authorize("edit", { type: "org" });
	return getServiceDb()
		.select({
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			dueAt: privacyCase.dueAt,
		})
		.from(privacyCase)
		.where(
			and(
				lt(privacyCase.dueAt, now),
				isNull(privacyCase.decidedAt),
				or(
					eq(privacyCase.organizationId, actor.orgId),
					eq(privacyCase.subjectUserId, actor.userId),
				),
			),
		)
		.orderBy(privacyCase.dueAt);
}

/**
 * A case's full history, oldest first — the evidence that the process was followed.
 *
 * Gated on the case, like every step that names one. It had no gate before #4854, which made the
 * complete ledger of any request — every decision, every reason, every actor — readable by anyone
 * who could quote or guess a reference.
 */
export async function privacyCaseHistory(reference: string) {
	// The ONE step the subject may take on their own case. It writes nothing and discloses nothing
	// but their own record, which is the thing a data-subject request exists to give them.
	const { c } = await authorizeCase(reference, { subjectMayAct: true });
	return getServiceDb()
		.select()
		.from(privacyCaseEvent)
		.where(eq(privacyCaseEvent.caseId, c.id))
		.orderBy(privacyCaseEvent.at);
}

/**
 * Tombstones a restore has not yet replayed.
 *
 * A backup taken before an erasure reinstates the data; until each tombstone is replayed against
 * the restored database, the reinstated rows are indistinguishable from rows that were never
 * erased. The list that has to reach zero before a restored instance serves traffic is therefore
 * the DEPLOYMENT'S, and this is not it — it is the caller's slice of it.
 *
 * ⚠️ THE RESTORE RUNBOOK MUST NOT READ THIS. It took no argument and had no gate before #4854, and
 * an ungated `"use server"` export is a POST endpoint, so it answered every erasure this
 * deployment has ever performed — the subject hashes, the erased user ids, the case references and
 * the scopes — to anyone who asked. Scoping it to the caller is what makes it safe to expose, and
 * it is exactly what makes it the wrong source for a restore: a replay that skipped another
 * tenant's tombstones would silently reinstate erased data. The restore reads
 * `privacy_erasure_tombstone` directly, which is where a controller-wide operation belongs.
 */
export async function unreplayedTombstones() {
	const actor = await authorize("edit", { type: "org" });
	return getServiceDb()
		.select(getTableColumns(privacyErasureTombstone))
		.from(privacyErasureTombstone)
		.leftJoin(
			privacyCase,
			eq(privacyCase.reference, privacyErasureTombstone.caseReference),
		)
		.where(
			and(
				isNull(privacyErasureTombstone.replayedAt),
				or(
					eq(privacyCase.organizationId, actor.orgId),
					eq(privacyErasureTombstone.erasedUserId, actor.userId),
				),
			),
		)
		.orderBy(desc(privacyErasureTombstone.erasedAt));
}

/** Exported for the kind union without importing the enum module at every call site. */
export type { PrivacyCaseKind };
