"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff privacy queue's decisions. Every one: assertPlatformAdmin() (the act-capable allowlist,
// distinct from read-only support staff) → zod-validated form input → withPlatformAudit (a
// committed attempt row before the act, a result row after, a required reason) → the console's
// platform route, which runs the same steps a console decision does and writes the case's ledger.
// Nothing here writes a privacy table directly.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPlatformAdmin } from "@/lib/auth/staff";
import { withPlatformAudit } from "@/lib/platform/audit";
import { privacyAction } from "@/lib/platform/console-client";

/** What a queue form shows after a submit. */
export interface PrivacyFormState {
	ok: boolean;
	message: string;
}

const reference = z.string().trim().regex(/^DSR-[0-9A-F]{8}$/, "Not a privacy request reference.");

const decisionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.enum(["verify", "fulfil"]), reference, auditReason: z.string().trim().min(1, "A reason is required") }),
	z.object({
		action: z.enum(["extend", "hold", "refuse"]),
		reference,
		reason: z.string().trim().min(10, "State the reason the subject will be told (10 characters or more)."),
	}),
]);

const openSchema = z.object({
	kind: z.enum(["access", "export", "rectification", "erasure", "restriction", "objection", "portability"]),
	email: z.string().trim().email("Enter the address the request came from."),
	auditReason: z.string().trim().min(1, "A reason is required"),
});

/** The first validation message of a failed parse. */
function firstIssue(error: z.ZodError): string {
	return error.issues[0]?.message ?? "Check the form and try again.";
}

/** Reads a string field off a form, or "" when it is absent or a file. */
function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

/** Takes one decision on a case: verify, fulfil, extend, hold or refuse. */
export async function decidePrivacyCase(
	_prev: PrivacyFormState | null,
	form: FormData,
): Promise<PrivacyFormState> {
	const staff = await assertPlatformAdmin();
	const parsed = decisionSchema.safeParse({
		action: field(form, "action"),
		reference: field(form, "reference"),
		reason: field(form, "reason"),
		auditReason: field(form, "auditReason"),
	});
	if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
	const d = parsed.data;
	// The audit reason for a decision that carries its own legal reason is that reason.
	const auditReason = "auditReason" in d ? d.auditReason : d.reason;
	try {
		const result = await withPlatformAudit(
			staff.email,
			`privacy_${d.action}`,
			null,
			auditReason,
			{ privacyReference: d.reference, privacyAction: d.action },
			() =>
				"reason" in d
					? privacyAction({ action: d.action, reference: d.reference, reason: d.reason, staffUserId: staff.userId })
					: privacyAction({ action: d.action, reference: d.reference, staffUserId: staff.userId }),
		);
		revalidatePath("/privacy");
		revalidatePath(`/privacy/${d.reference}`);
		return { ok: result.ok, message: result.message };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : "The action failed." };
	}
}

/** Opens a case from a request that arrived by email. */
export async function openPrivacyCaseFromEmail(
	_prev: PrivacyFormState | null,
	form: FormData,
): Promise<PrivacyFormState> {
	const staff = await assertPlatformAdmin();
	const parsed = openSchema.safeParse({
		kind: field(form, "kind"),
		email: field(form, "email"),
		auditReason: field(form, "auditReason"),
	});
	if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
	const { kind, email, auditReason } = parsed.data;
	try {
		const result = await withPlatformAudit(
			staff.email,
			"privacy_open",
			null,
			auditReason,
			{ privacyAction: "open", privacyKind: kind },
			() => privacyAction({ action: "open", kind, email, staffUserId: staff.userId }),
		);
		revalidatePath("/privacy");
		return { ok: result.ok, message: result.message };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : "The action failed." };
	}
}
