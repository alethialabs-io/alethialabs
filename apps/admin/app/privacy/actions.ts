"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Staff handling of data-subject requests (#7222): record a request that arrived by email, verify
// identity, extend, apply a legal hold, fulfil an erasure, refuse with grounds.
//
// Every act: assertPlatformAdmin() (Cloudflare Access + PLATFORM_ADMIN_EMAILS — the act-capable
// allowlist, not the read-only support one) → withPlatformAudit (a committed attempt row with the
// required reason, then a result row) → the console's platform route, which runs the SAME step the
// console's own server action runs (apps/console/lib/privacy/case-steps.ts). Nothing here writes a
// privacy table: the console owns them, and the deadline arithmetic and the
// verified-before-destroyed rule exist once, there.
//
// WHAT THE AUDIT ROWS CARRY. `platform_audit` is write-once, and so is the privacy ledger; neither
// can be erased later. So neither is given the subject's address: the open step's audit row names
// the kind and the reference, never the email (which the console hashes on the way in). The
// identity-verification note goes to the audit row only, and the form asks for HOW identity was
// checked, not the evidence itself.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPlatformAdmin } from "@/lib/auth/staff";
import { withPlatformAudit } from "@/lib/platform/audit";
import { openPrivacyCase, takePrivacyStep } from "@/lib/platform/console-client";
import {
	MIN_EXTENSION_REASON,
	MIN_REFUSAL_REASON,
	MIN_VERIFICATION_NOTE,
	PRIVACY_KINDS,
	REFERENCE_PATTERN,
} from "./constants";

/** What every privacy action answers: success, and a sentence for the operator either way. */
export interface PrivacyActionResult {
	ok: boolean;
	error?: string;
	/** What happened, in words — the erasure's outcome, the new deadline. */
	message?: string;
	/** For an opened case — the reference to quote in the reply to the subject. */
	reference?: string;
}

const reference = z.string().trim().regex(REFERENCE_PATTERN, "Not a privacy request reference.");

const openSchema = z.object({
	kind: z.enum(PRIVACY_KINDS),
	email: z.string().trim().email("Enter the address the request came from"),
	/** The day the email arrived, YYYY-MM-DD. The clock starts then, not when it is recorded. */
	receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the day the request arrived"),
});

const verifySchema = z.object({
	reference,
	how: z
		.string()
		.trim()
		.min(MIN_VERIFICATION_NOTE, "Say how identity was verified (not the evidence itself)")
		.max(2000),
});

const reasonSchema = (min: number, message: string) =>
	z.object({ reference, reason: z.string().trim().min(min, message).max(2000) });

const extendSchema = reasonSchema(
	MIN_EXTENSION_REASON,
	"An extension must state why the request is complex — the subject has to be told.",
);
const holdSchema = reasonSchema(
	MIN_EXTENSION_REASON,
	"A legal hold must state its basis — the subject is entitled to know it.",
);
const refuseSchema = reasonSchema(
	MIN_REFUSAL_REASON,
	"A refusal must state its grounds and that the subject may complain to the supervisory authority.",
);

const fulfilSchema = z
	.object({ reference, confirm: z.string().trim() })
	.refine((v) => v.confirm === v.reference, {
		message: "Type the reference exactly to confirm the erasure.",
	});

const openAnswer = z.object({ reference, linkedAccount: z.boolean() });
const extendAnswer = z.object({ outcome: z.literal("extended"), dueAt: z.string() });
const erasureAnswer = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("erased"),
		rowsErased: z.number(),
		rowsPseudonymized: z.number(),
		tablesRetained: z.number(),
	}),
	z.object({ outcome: z.literal("paused_by_legal_hold"), reason: z.string() }),
	z.object({ outcome: z.literal("refused_live_resources"), message: z.string() }),
]);

/** The first validation message, as the operator should read it. */
function firstIssue(error: z.ZodError): string {
	return error.issues[0]?.message ?? "Invalid input";
}

/** The error text an action answers with. */
function failure(err: unknown, fallback: string): PrivacyActionResult {
	return { ok: false, error: err instanceof Error ? err.message : fallback };
}

/** Refreshes the register and the case page after a step. */
function refresh(ref?: string): void {
	revalidatePath("/privacy");
	if (ref) revalidatePath(`/privacy/${ref}`);
}

/**
 * Records a request that arrived by email. The case is linked to the account the address belongs
 * to, when there is one, and is NOT verified — that is the next, separate step.
 */
export async function openEmailedPrivacyCase(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = openSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const { kind, email, receivedOn } = parsed.data;
	// The day, at its first instant in UTC — but never later than now: an operator east of UTC who
	// records today's email shortly after midnight names a day that has not started in UTC yet.
	const now = Date.now();
	const dayStart = new Date(`${receivedOn}T00:00:00.000Z`).getTime();
	if (Number.isNaN(dayStart) || dayStart > now + 86_400_000) {
		return { ok: false, error: "The request cannot have arrived in the future." };
	}
	const receivedAt = new Date(Math.min(dayStart, now)).toISOString();

	try {
		const answer = await withPlatformAudit(
			staff.email,
			"privacy_open_case",
			null,
			`Recorded an emailed ${kind} request received on ${receivedOn}`,
			{},
			async () =>
				openAnswer.parse(
					await openPrivacyCase({
						actorUserId: staff.userId,
						kind,
						email,
						receivedAt,
					}),
				),
		);
		refresh(answer.reference);
		return {
			ok: true,
			reference: answer.reference,
			message: answer.linkedAccount
				? `Opened ${answer.reference}. The address matches an account; verify identity before acting.`
				: `Opened ${answer.reference}. The address matches no account, so an erasure has to be done by hand.`,
		};
	} catch (err) {
		return failure(err, "Could not open the request");
	}
}

/** Marks identity verified. The note on HOW goes to the platform audit trail, not the ledger. */
export async function verifyPrivacyIdentity(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = verifySchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const { reference: ref, how } = parsed.data;

	try {
		await withPlatformAudit(
			staff.email,
			"privacy_verify_identity",
			null,
			`${ref}: identity verified — ${how}`,
			{},
			() => takePrivacyStep(ref, "verify", { actorUserId: staff.userId }),
		);
		refresh(ref);
		return { ok: true, message: "Identity verified." };
	} catch (err) {
		return failure(err, "Could not verify identity");
	}
}

/** Takes the single extension; the reason is told to the subject. */
export async function extendPrivacyRequest(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = extendSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const { reference: ref, reason } = parsed.data;

	try {
		const answer = await withPlatformAudit(
			staff.email,
			"privacy_extend",
			null,
			`${ref}: ${reason}`,
			{},
			async () =>
				extendAnswer.parse(
					await takePrivacyStep(ref, "extend", { actorUserId: staff.userId, reason }),
				),
		);
		refresh(ref);
		return { ok: true, message: `Extended; the response is now due ${answer.dueAt.slice(0, 10)}.` };
	} catch (err) {
		return failure(err, "Could not extend the request");
	}
}

/** Applies a legal hold: pauses the destructive half, never refuses. */
export async function holdPrivacyRequest(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = holdSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const { reference: ref, reason } = parsed.data;

	try {
		await withPlatformAudit(staff.email, "privacy_legal_hold", null, `${ref}: ${reason}`, {}, () =>
			takePrivacyStep(ref, "hold", { actorUserId: staff.userId, reason }),
		);
		refresh(ref);
		return { ok: true, message: "Legal hold applied. The request is paused, not refused." };
	} catch (err) {
		return failure(err, "Could not apply the hold");
	}
}

/** Refuses the request; the grounds and the right to complain are recorded and told to the subject. */
export async function refusePrivacyRequest(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = refuseSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const { reference: ref, reason } = parsed.data;

	try {
		await withPlatformAudit(staff.email, "privacy_refuse", null, `${ref}: ${reason}`, {}, () =>
			takePrivacyStep(ref, "refuse", { actorUserId: staff.userId, reason }),
		);
		refresh(ref);
		return { ok: true, message: "Refused. Tell the subject the grounds and their right to complain." };
	} catch (err) {
		return failure(err, "Could not refuse the request");
	}
}

/**
 * Performs the erasure. The reference must be typed back — the client's confirmation dialog asks
 * for it, and this re-checks it, so a POST that skipped the dialog cannot erase anything.
 *
 * Three outcomes, and only one erased anything: a legal hold pauses it, and live resources in the
 * subject's organizations refuse it with the case left open. Both are answers, not failures.
 */
export async function fulfilPrivacyErasure(form: unknown): Promise<PrivacyActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = fulfilSchema.safeParse(form);
	if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
	const ref = parsed.data.reference;

	try {
		const answer = await withPlatformAudit(
			staff.email,
			"privacy_fulfil_erasure",
			null,
			`${ref}: erasure confirmed by typing the reference`,
			{},
			async () =>
				erasureAnswer.parse(
					await takePrivacyStep(ref, "fulfil-erasure", { actorUserId: staff.userId }),
				),
		);
		refresh(ref);
		switch (answer.outcome) {
			case "erased":
				return {
					ok: true,
					message:
						`Erased ${answer.rowsErased} rows and pseudonymized ${answer.rowsPseudonymized}; ` +
						`${answer.tablesRetained} tables retained under their legal basis.`,
				};
			case "paused_by_legal_hold":
				return { ok: false, error: `Nothing erased — paused by a legal hold: ${answer.reason}` };
			case "refused_live_resources":
				return { ok: false, error: `Nothing erased. ${answer.message}` };
		}
	} catch (err) {
		return failure(err, "Could not perform the erasure");
	}
}
