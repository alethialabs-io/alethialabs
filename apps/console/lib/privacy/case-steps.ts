// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The handling steps of a privacy case, once standing over it has been established.
//
// Two callers decide cases, each with its own proof of standing, and both run these SAME steps:
//
//   · the console's `cases.ts` server actions — an admin of the organization the case was raised in
//     (`authorizeCase`);
//   · the staff privacy queue in `apps/admin`, through the platform route
//     (`app/api/internal/platform/privacy`) — an allowlisted platform operator, for the
//     controller-level cases no organization can decide (every self-serve request, and every request
//     that arrives by email).
//
// `server-only`, NOT `"use server"`: every export takes the case and the actor as parameters, and an
// export of a `"use server"` module is a POST endpoint whatever its intended caller. The rules that
// matter legally are enforced here, so neither caller can skip them: a refusal and an extension must
// carry a reason, a legal hold pauses rather than refuses, and only one extension is available.

import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { type PrivacyCase, privacyCase, user } from "@/lib/db/schema";
import type { PrivacyCaseKind } from "@/lib/db/schema/enums";
import { newReference, recordEvent, subjectHash } from "@/app/server/actions/privacy/ledger";
import { PRIVACY_RESPONSE_DAYS } from "@/app/server/actions/privacy/response-period";

/** The single extension available for a complex request, in days (two further months). */
const EXTENSION_DAYS = 60;

/**
 * The shape of a reference, checked before it reaches a query. `newReference` mints `DSR-` and
 * eight upper-case hex characters, so anything else is not a reference this deployment issued.
 */
export const referenceSchema = z
	.string()
	.trim()
	.regex(/^DSR-[0-9A-F]{8}$/, "Not a privacy request reference.");

/** Loads a case by reference, or null when nothing matches. Says nothing about who may act on it. */
export async function caseByReference(reference: string): Promise<PrivacyCase | null> {
	const [c] = await getServiceDb()
		.select()
		.from(privacyCase)
		.where(eq(privacyCase.reference, referenceSchema.parse(reference)))
		.limit(1);
	return c ?? null;
}

/** Throws unless `reason` is at least `min` characters, with the message the subject's right needs. */
function requireReason(reason: string, min: number, message: string): string {
	const trimmed = reason.trim();
	if (trimmed.length < min) throw new Error(message);
	return trimmed;
}

/** Marks identity verified. Nothing is disclosed or destroyed before this. */
export async function verifyCase(c: PrivacyCase, actorUserId: string | null, now: Date): Promise<void> {
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

/** The reason check {@link extendCase} applies, exported so a caller can check before authorizing. */
export function extensionReason(reason: string): string {
	return requireReason(
		reason,
		10,
		"An extension must state why the request is complex — the subject has to be told.",
	);
}

/** Takes the single permitted extension. The reason is required and disclosable. */
export async function extendCase(
	c: PrivacyCase,
	actorUserId: string | null,
	reason: string,
	now: Date,
): Promise<{ dueAt: Date }> {
	const why = extensionReason(reason);
	if (c.extendedAt) {
		throw new Error("This request has already been extended; only one extension is available.");
	}
	const dueAt = new Date(c.dueAt.getTime() + EXTENSION_DAYS * 86_400_000);
	await getServiceDb()
		.update(privacyCase)
		.set({ dueAt, extendedAt: now, extensionReason: why, updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"note",
		{ summary: `Response period extended to ${dueAt.toISOString().slice(0, 10)}: ${why}` },
		actorUserId,
	);
	return { dueAt };
}

/** The reason check {@link holdCase} applies. */
export function holdReason(reason: string): string {
	return requireReason(reason, 10, "A legal hold must state its basis — the subject is entitled to know it.");
}

/** Applies a legal hold. Pauses the destructive half; never refuses the request. */
export async function holdCase(
	c: PrivacyCase,
	actorUserId: string | null,
	reason: string,
	now: Date,
): Promise<void> {
	const why = holdReason(reason);
	await getServiceDb()
		.update(privacyCase)
		.set({ legalHoldReason: why, updatedAt: now })
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"legal_hold_applied",
		{ summary: `Legal hold applied: ${why}. The request is paused, not refused.` },
		actorUserId,
	);
}

/** The reason check {@link refuseCase} applies. */
export function refusalReason(reason: string): string {
	return requireReason(
		reason,
		20,
		"A refusal must state its grounds. The subject has to be told why, and that they may " +
			"complain to the supervisory authority.",
	);
}

/** Refuses a request, with the reason the law requires. */
export async function refuseCase(
	c: PrivacyCase,
	actorUserId: string | null,
	reason: string,
	now: Date,
): Promise<void> {
	const why = refusalReason(reason);
	await getServiceDb()
		.update(privacyCase)
		.set({
			state: "refused",
			refusalReason: why,
			decidedAt: now,
			decidedByUserId: actorUserId,
			scheduledFor: null,
			linkTokenSha256: null,
			updatedAt: now,
		})
		.where(eq(privacyCase.id, c.id));
	await recordEvent(c.id, "refused", { summary: `Refused: ${why}` }, actorUserId);
}

/**
 * Opens a case from a request that arrived OUTSIDE the console — an email to the privacy inbox —
 * for the staff queue. The address is hashed on the way in; the account, when one has that address,
 * is linked so an erasure has rows to match. Identity is NOT verified here: that is a separate,
 * recorded step, because the request did not come from a signed-in session. Nothing the sender
 * wrote is stored: the ledger must never carry the subject's data.
 */
export async function openCaseFromEmail(
	input: { kind: PrivacyCaseKind; email: string },
	actorUserId: string | null,
	now: Date,
): Promise<{ reference: string; subjectFound: boolean }> {
	const email = input.email.trim().toLowerCase();
	const db = getServiceDb();
	const [subject] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	const reference = newReference();
	const [row] = await db
		.insert(privacyCase)
		.values({
			reference,
			kind: input.kind,
			subjectUserId: subject?.id ?? null,
			subjectEmailSha256: subjectHash(email),
			organizationId: null,
			receivedAt: now,
			dueAt: new Date(now.getTime() + PRIVACY_RESPONSE_DAYS * 86_400_000),
		})
		.returning({ id: privacyCase.id });
	if (!row) throw new Error("Could not open the request.");
	await recordEvent(
		row.id,
		"received",
		{
			summary:
				`Request received (${input.kind}) by email and opened from the staff privacy queue. ` +
				`${subject ? "An account with the address exists and is linked." : "No account has the address."} ` +
				`Response due within ${PRIVACY_RESPONSE_DAYS} days.`,
		},
		actorUserId,
	);
	return { reference, subjectFound: Boolean(subject) };
}
