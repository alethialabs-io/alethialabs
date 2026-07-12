// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Append-only break-glass audit writer. Rows are committed BEFORE the action (`phase: "attempt"`)
// and appended after (`phase: "result"`) — never updated (the table is trigger-enforced WORM;
// programmables.sql). Written through the service role (getServiceDb) since the app role has no
// grant on the table at all.

import type { BreakglassActionInput } from "@/types/jsonb.types";
import { getServiceDb } from "@/lib/db";
import type {
	BreakglassAction,
	BreakglassBlastRadius,
} from "@/lib/db/schema/enums";
import { breakglassAudit } from "@/lib/db/schema";

/** The fields common to every audit row. */
export interface BreakglassAuditInput {
	sessionId: string | null;
	actorEmail: string;
	action: BreakglassAction;
	blastRadius: BreakglassBlastRadius;
	resourceType: string;
	resourceId: string | null;
	reason: string;
	input?: BreakglassActionInput;
	approverEmail?: string | null;
	approvalId?: string | null;
}

/**
 * Writes the pre-action "attempt" row and returns its id. This MUST be awaited before the mutation
 * runs — a failed action is then still on the immutable record. Its own commit is independent of the
 * action's, so a later throw cannot erase it.
 */
export async function writeAttemptAudit(
	row: BreakglassAuditInput,
): Promise<number> {
	const [inserted] = await getServiceDb()
		.insert(breakglassAudit)
		.values({
			session_id: row.sessionId,
			actor_email: row.actorEmail,
			action: row.action,
			blast_radius: row.blastRadius,
			resource_type: row.resourceType,
			resource_id: row.resourceId,
			input: row.input,
			reason: row.reason,
			approver_email: row.approverEmail ?? null,
			approval_id: row.approvalId ?? null,
			phase: "attempt",
		})
		.returning({ id: breakglassAudit.id });
	return inserted.id;
}

/** Appends the post-action "result" row (outcome ok|error). Append-only — never an update. */
export async function writeResultAudit(
	row: BreakglassAuditInput,
	outcome: "ok" | "error",
	detail: string | null,
): Promise<void> {
	await getServiceDb()
		.insert(breakglassAudit)
		.values({
			session_id: row.sessionId,
			actor_email: row.actorEmail,
			action: row.action,
			blast_radius: row.blastRadius,
			resource_type: row.resourceType,
			resource_id: row.resourceId,
			input: row.input,
			reason: row.reason,
			approver_email: row.approverEmail ?? null,
			approval_id: row.approvalId ?? null,
			phase: "result",
			outcome,
			detail: detail?.slice(0, 2000) ?? null,
		});
}
