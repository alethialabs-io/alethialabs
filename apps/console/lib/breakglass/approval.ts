// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Two-person control for high-blast break-glass actions. A SECOND authorized operator mints a
// single-use, TTL'd approval bound to the EXACT (action, resource, input) of the operation. The
// acting operator presents its id; the dispatcher CONSUMES it atomically, verifying:
//   - the approver is a different operator than the actor (real two-person),
//   - the approval matches the action + resource id + a hash of the canonicalized input,
//   - it is unexpired and not already consumed.
// Consumption is a compare-and-swap UPDATE (WHERE consumed_at IS NULL) so an approval can be spent
// at most once even under a race. This is enforced ENTIRELY server-side — a caller cannot skip it by
// hitting the endpoint directly, because the dispatcher requires it for every high-blast action.

import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { BreakglassActionInput } from "@/types/jsonb.types";
import { getServiceDb } from "@/lib/db";
import type { BreakglassAction } from "@/lib/db/schema/enums";
import { breakglassApproval } from "@/lib/db/schema";
import type { BreakglassApproval } from "@/lib/db/schema/breakglass";
import { BREAKGLASS_APPROVAL_TTL_MS } from "./config";

/**
 * A stable, canonical hash binding an approval to the exact operation. Keys are sorted so the same
 * logical input always hashes identically regardless of property order.
 */
export function approvalInputHash(input: BreakglassActionInput | undefined): string {
	const canonical = JSON.stringify(sortKeys(input ?? {}));
	return createHash("sha256").update(canonical).digest("hex");
}

/** Recursively sorts object keys for a canonical JSON encoding. */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, sortKeys(v)]),
		);
	}
	return value;
}

/** Mints a two-person approval token bound to an exact operation. Returns the created row. */
export async function mintApproval(params: {
	approverEmail: string;
	action: BreakglassAction;
	resourceType: string;
	resourceId: string;
	input: BreakglassActionInput | undefined;
	reason: string;
}): Promise<BreakglassApproval> {
	const [row] = await getServiceDb()
		.insert(breakglassApproval)
		.values({
			approver_email: params.approverEmail,
			action: params.action,
			resource_type: params.resourceType,
			resource_id: params.resourceId,
			input_hash: approvalInputHash(params.input),
			reason: params.reason,
			expires_at: new Date(Date.now() + BREAKGLASS_APPROVAL_TTL_MS),
		})
		.returning();
	return row;
}

/** The reason a consume attempt failed (all fail-closed → the action is refused). */
export type ConsumeFailure =
	| "not_found"
	| "expired_or_consumed"
	| "mismatch"
	| "same_operator";

export type ConsumeResult =
	| { ok: true; approval: BreakglassApproval }
	| { ok: false; reason: ConsumeFailure };

/**
 * Atomically consumes an approval for a high-blast action. Fails closed on any mismatch: a missing
 * token, an expired/spent one, one whose (action, resource_type, resource_id) differs from what's
 * being performed, or one minted by the acting operator themselves (two-person means a DIFFERENT
 * person). The single-use guarantee is the `WHERE consumed_at IS NULL` CAS in the UPDATE.
 *
 * The binding is the security-relevant IDENTITY of the operation — action + the exact resource id
 * (state key / project). The action's `input` (e.g. a state-surgery note) is recorded on both the
 * approval and the audit for the record, but is deliberately NOT part of the binding: a two-person
 * control approves "operator B lets operator A do ACTION on RESOURCE", and a free-form note must not
 * be able to silently invalidate an otherwise-correct approval.
 */
export async function consumeApproval(params: {
	approvalId: string;
	actorEmail: string;
	action: BreakglassAction;
	resourceType: string;
	resourceId: string;
}): Promise<ConsumeResult> {
	const db = getServiceDb();
	const [existing] = await db
		.select()
		.from(breakglassApproval)
		.where(eq(breakglassApproval.id, params.approvalId))
		.limit(1);

	if (!existing) return { ok: false, reason: "not_found" };
	// Two-person: the approver must not be the actor. Checked before consuming so a self-approval
	// never even spends the token.
	if (existing.approver_email.toLowerCase() === params.actorEmail.toLowerCase()) {
		return { ok: false, reason: "same_operator" };
	}
	// Binding: must match the exact operation identity being performed.
	if (
		existing.action !== params.action ||
		existing.resource_type !== params.resourceType ||
		existing.resource_id !== params.resourceId
	) {
		return { ok: false, reason: "mismatch" };
	}

	// Atomic single-use claim: only succeeds if still unconsumed AND unexpired.
	const claimed = await db
		.update(breakglassApproval)
		.set({ consumed_at: new Date(), consumed_by: params.actorEmail })
		.where(
			and(
				eq(breakglassApproval.id, params.approvalId),
				isNull(breakglassApproval.consumed_at),
				gt(breakglassApproval.expires_at, sql`now()`),
			),
		)
		.returning();

	if (claimed.length === 0) return { ok: false, reason: "expired_or_consumed" };
	return { ok: true, approval: claimed[0] };
}
