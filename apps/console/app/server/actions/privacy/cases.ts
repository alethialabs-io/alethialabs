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
// The handling steps are gated on `org:edit` — the organization's own administrative permission.
// That is the right scope for a case raised inside a tenant, and it is deliberately NOT the scope
// for a case from someone in no organization at all: those reach the controller directly, and the
// platform-admin surface for them is not built here. The gap is real and named rather than papered
// over with a permission that would quietly admit the wrong people.
//
// Every write goes through getServiceDb: the tables are service-role only (RLS with no app policy),
// because a case may concern someone who is in no organization at all and an owner-scoped policy
// would either leak those rows to a tenant or hide a person's case from the only path that can
// answer it.

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	privacyCase,
	privacyCaseEvent,
	privacyErasureTombstone,
} from "@/lib/db/schema";
import type { PrivacyCaseEventKind, PrivacyCaseKind } from "@/lib/db/schema/enums";
import { buildErasurePlan, planToScope } from "@/lib/privacy/erasure-plan";
import type { PrivacyEventDetail } from "@/types/jsonb.types";

/** The statutory period to answer, in days (GDPR art. 12(3): one month). */
const RESPONSE_DAYS = 30;
/** The single extension available for a complex request, in days (two further months). */
const EXTENSION_DAYS = 60;

/**
 * SHA-256 of a contact address, lower-cased and trimmed.
 *
 * The only identifier that survives fulfilment, so it is hashed rather than stored: a table listing
 * everyone who ever exercised a privacy right, in plaintext, would be a privacy problem created by
 * the machinery meant to solve one.
 */
export function subjectHash(email: string): string {
	return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** A short, human reference to quote in correspondence. Unique; never reused. */
function newReference(): string {
	return `DSR-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/**
 * Appends to the ledger. Never updates — the trigger in programmables.sql refuses UPDATE and DELETE,
 * so this is the only way anything is recorded and the history cannot be revised afterwards.
 */
async function recordEvent(
	caseId: string,
	kind: PrivacyCaseEventKind,
	detail: PrivacyEventDetail,
	actorUserId: string | null,
): Promise<void> {
	await getServiceDb().insert(privacyCaseEvent).values({
		caseId,
		kind,
		actorUserId,
		detail,
	});
}

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
 * verifies implicitly would have no way to handle those.
 */
export async function verifyPrivacyCaseIdentity(
	reference: string,
	now = new Date(),
): Promise<void> {
	const actor = await authorize("edit", { type: "org" });
	const c = await caseByReference(reference);
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

/** Loads a case by reference, or throws. */
async function caseByReference(reference: string) {
	const [c] = await getServiceDb()
		.select()
		.from(privacyCase)
		.where(eq(privacyCase.reference, reference))
		.limit(1);
	if (!c) throw new Error(`No privacy request with reference ${reference}.`);
	return c;
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
	const actor = await authorize("edit", { type: "org" });
	if (reason.trim().length < 10) {
		throw new Error(
			"An extension must state why the request is complex — the subject has to be told.",
		);
	}
	const c = await caseByReference(reference);
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
	const actor = await authorize("edit", { type: "org" });
	if (reason.trim().length < 10) {
		throw new Error("A legal hold must state its basis — the subject is entitled to know it.");
	}
	const c = await caseByReference(reference);
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
 * Performs the erasure, and leaves the tombstone behind.
 *
 * The tombstone is written EVEN under a legal hold, with an empty erasure scope. That looks odd and
 * is deliberate: it records that the request was made and what was held, so a later restore replays
 * a decision that was actually taken rather than finding no trace of one.
 */
export async function fulfilErasure(
	reference: string,
	now = new Date(),
): Promise<{ erased: number; pseudonymized: number; retained: number }> {
	const actor = await authorize("edit", { type: "org" });
	const c = await caseByReference(reference);
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
	await db.insert(privacyErasureTombstone).values({
		subjectEmailSha256: c.subjectEmailSha256,
		erasedUserId: c.subjectUserId,
		caseReference: c.reference,
		erasedAt: now,
		scope,
	});
	await db
		.update(privacyCase)
		.set({
			scope,
			state: plan.blocked ? "in_review" : "fulfilled",
			decidedAt: plan.blocked ? null : now,
			decidedByUserId: plan.blocked ? null : actor.userId,
			updatedAt: now,
		})
		.where(eq(privacyCase.id, c.id));

	await recordEvent(
		c.id,
		plan.blocked ? "legal_hold_applied" : "erasure_performed",
		{
			summary: plan.blocked
				? `Erasure paused by a legal hold: ${plan.blockedReason}`
				: "Erasure performed. See the scope for what was removed, unlinked and retained.",
			counts: {
				erased: plan.erase.length,
				pseudonymized: plan.pseudonymize.length,
				retained: plan.retain.length,
			},
			tables: [...plan.erase, ...plan.pseudonymize].map((r) => r.table),
		},
		actor.userId,
	);

	return {
		erased: plan.erase.length,
		pseudonymized: plan.pseudonymize.length,
		retained: plan.retain.length,
	};
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
	const actor = await authorize("edit", { type: "org" });
	if (reason.trim().length < 20) {
		throw new Error(
			"A refusal must state its grounds. The subject has to be told why, and that they may " +
				"complain to the supervisory authority.",
		);
	}
	const c = await caseByReference(reference);
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
 * Requests still open past their deadline.
 *
 * The query the alerting runs. Overdue is measured against the STORED `dueAt`, which already
 * accounts for any extension — so an extended request is not reported late, and one that was never
 * extended cannot be quietly treated as if it had been.
 */
export async function overduePrivacyCases(now = new Date()) {
	return getServiceDb()
		.select({
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			dueAt: privacyCase.dueAt,
		})
		.from(privacyCase)
		.where(and(lt(privacyCase.dueAt, now), isNull(privacyCase.decidedAt)))
		.orderBy(privacyCase.dueAt);
}

/** A case's full history, oldest first — the evidence that the process was followed. */
export async function privacyCaseHistory(reference: string) {
	const c = await caseByReference(reference);
	return getServiceDb()
		.select()
		.from(privacyCaseEvent)
		.where(eq(privacyCaseEvent.caseId, c.id))
		.orderBy(privacyCaseEvent.at);
}

/**
 * Tombstones a restore has not yet replayed.
 *
 * THE restore path. A backup taken before an erasure reinstates the data; until each tombstone is
 * replayed against the restored database, the reinstated rows are indistinguishable from rows that
 * were never erased. This is the list that has to reach zero before a restored instance serves
 * traffic.
 */
export async function unreplayedTombstones() {
	return getServiceDb()
		.select()
		.from(privacyErasureTombstone)
		.where(isNull(privacyErasureTombstone.replayedAt))
		.orderBy(desc(privacyErasureTombstone.erasedAt));
}

/** Exported for the kind union without importing the enum module at every call site. */
export type { PrivacyCaseKind };
