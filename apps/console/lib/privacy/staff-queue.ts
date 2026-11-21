// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff privacy queue's decisions, as the console carries them out.
//
// `apps/admin` lists cases from the database directly (read-only) and sends every DECISION here,
// through `app/api/internal/platform/privacy` and its dedicated bearer secret — the same pattern as
// the operator plane's org provisioning. The admin app has already established that the caller is
// on `PLATFORM_ADMIN_EMAILS` behind Cloudflare Access, and written its own WORM audit row; what this
// module adds is that every step goes through the SAME code a console decision does
// (`case-steps.ts`, `erasure.ts`, `export.ts`), and is recorded in the case's ledger under the staff
// member's own user id.

import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { privacyCaseKind } from "@/lib/db/schema/enums";
import {
	caseByReference,
	extendCase,
	holdCase,
	openCaseFromEmail,
	refuseCase,
	referenceSchema,
	verifyCase,
} from "./case-steps";
import { type ErasureFulfilment, performErasure } from "./erasure";
import { deliverExport } from "./export";

/** One staff decision, as the admin app sends it. */
export const staffPrivacyActionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("verify"), reference: referenceSchema, staffUserId: z.string().uuid() }),
	z.object({
		action: z.enum(["extend", "hold", "refuse"]),
		reference: referenceSchema,
		reason: z.string().trim().min(1).max(2000),
		staffUserId: z.string().uuid(),
	}),
	z.object({ action: z.literal("fulfil"), reference: referenceSchema, staffUserId: z.string().uuid() }),
	z.object({
		action: z.literal("open"),
		kind: z.enum(privacyCaseKind.enumValues),
		email: z.string().trim().email(),
		staffUserId: z.string().uuid(),
	}),
]);

/** The input of {@link runStaffPrivacyAction}. */
export type StaffPrivacyAction = z.infer<typeof staffPrivacyActionSchema>;

/** What a staff decision did, in words the queue shows the operator. */
export type StaffPrivacyResult =
	| { ok: true; message: string; reference?: string }
	| { ok: false; message: string };

/** The sentence for an erasure outcome. */
function describeErasure(r: ErasureFulfilment): StaffPrivacyResult {
	switch (r.outcome) {
		case "erased":
			return {
				ok: true,
				message: `Erased: ${r.rowsErased} row(s) deleted, ${r.rowsPseudonymized} unlinked, ${r.tablesRetained} table(s) retained by law.`,
			};
		case "paused_by_legal_hold":
			return { ok: false, message: `Paused by the legal hold: ${r.reason}` };
		case "refused_live_resources":
			return { ok: false, message: r.message };
	}
}

/** Carries out one staff decision. Throws only on a fault; a refusal of the step is `ok: false`. */
export async function runStaffPrivacyAction(
	input: StaffPrivacyAction,
	now: Date,
): Promise<StaffPrivacyResult> {
	if (input.action === "open") {
		const opened = await openCaseFromEmail({ kind: input.kind, email: input.email }, input.staffUserId, now);
		return {
			ok: true,
			reference: opened.reference,
			message: opened.subjectFound
				? `Opened ${opened.reference}, linked to the account with that address. Verify identity before acting on it.`
				: `Opened ${opened.reference}. No account has that address, so an erasure or export of account data has nothing to act on.`,
		};
	}
	const c = await caseByReference(input.reference);
	if (!c) return { ok: false, message: `No request has the reference ${input.reference}.` };
	const actor = input.staffUserId;
	try {
		switch (input.action) {
			case "verify":
				await verifyCase(c, actor, now);
				return { ok: true, message: "Identity verified." };
			case "extend": {
				const { dueAt } = await extendCase(c, actor, input.reason, now);
				return { ok: true, message: `Extended; the response is now due ${dueAt.toISOString().slice(0, 10)}.` };
			}
			case "hold":
				await holdCase(c, actor, input.reason, now);
				return { ok: true, message: "Legal hold applied. The request is paused, not refused." };
			case "refuse":
				await refuseCase(c, actor, input.reason, now);
				return { ok: true, message: "Refused, with the reason recorded." };
			case "fulfil":
				return await fulfil(c, actor, now);
		}
	} catch (err) {
		// The steps' own refusals (no reason, already extended, not verified) are messages for the
		// operator; anything else is a fault and propagates.
		if (err instanceof Error && !(err instanceof TypeError)) return { ok: false, message: err.message };
		throw err;
	}
}

/** Fulfils a case by its kind: an erasure, or an export for access / export / portability. */
async function fulfil(
	c: NonNullable<Awaited<ReturnType<typeof caseByReference>>>,
	actor: string,
	now: Date,
): Promise<StaffPrivacyResult> {
	if (c.kind === "erasure") return describeErasure(await performErasure(c, actor, now));
	if (c.kind !== "access" && c.kind !== "export" && c.kind !== "portability") {
		return {
			ok: false,
			message: `A ${c.kind} request is fulfilled by hand; record what was done on the case.`,
		};
	}
	if (!c.identityVerifiedAt) {
		return { ok: false, message: "Identity is not verified. Nothing is disclosed until it is." };
	}
	if (!c.subjectUserId) {
		return { ok: false, message: "The request names no account, so there is no account data to export." };
	}
	const [subject] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, c.subjectUserId))
		.limit(1);
	if (!subject) return { ok: false, message: "The account no longer exists." };
	const { expiresAt } = await deliverExport(
		c,
		{ userId: c.subjectUserId, email: subject.email },
		actor,
		now,
	);
	return {
		ok: true,
		message: `Export emailed to the account's address; the link expires ${expiresAt.toISOString()}.`,
	};
}
