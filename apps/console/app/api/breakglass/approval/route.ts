// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/breakglass/approval — a SECOND authorized operator mints a single-use, TTL'd two-person
// approval token bound to the exact (action, resource, input) a high-blast action will perform. The
// acting operator later presents its id to /execute; the dispatcher consumes it and enforces that
// the approver differs from the actor. Minting is itself audited.

import { mintApproval } from "@/lib/breakglass/approval";
import { writeAttemptAudit, writeResultAudit } from "@/lib/breakglass/audit";
import { catalogSpec } from "@/lib/breakglass/catalog";
import { guardBreakglass, json } from "@/lib/breakglass/guard";
import { resourceTypeFor } from "@/lib/breakglass/actions";
import { mintApprovalSchema } from "@/lib/validations/breakglass";
import type { BreakglassAction } from "@/lib/db/schema/enums";

export async function POST(req: Request): Promise<Response> {
	const guard = await guardBreakglass(req);
	if ("error" in guard) return guard.error;

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}
	const parsed = mintApprovalSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
	}
	const action = parsed.data.action as BreakglassAction;
	const spec = catalogSpec(action);
	if (!spec) return json({ error: `Unknown action ${action}` }, 400);
	// Only high-blast actions consume approvals; minting one for a low-blast action is a misuse.
	if (!spec.requiresApproval) {
		return json({ error: `Action ${action} does not require two-person approval.` }, 400);
	}

	const auditBase = {
		sessionId: null,
		actorEmail: guard.operator.email,
		action,
		blastRadius: spec.blastRadius,
		resourceType: resourceTypeFor(action),
		resourceId: parsed.data.resourceId,
		reason: parsed.data.reason,
		input: parsed.data.input,
	};
	await writeAttemptAudit({ ...auditBase, approverEmail: guard.operator.email });

	const approval = await mintApproval({
		approverEmail: guard.operator.email,
		action,
		resourceType: resourceTypeFor(action),
		resourceId: parsed.data.resourceId,
		input: parsed.data.input,
		reason: parsed.data.reason,
	});
	await writeResultAudit(
		{ ...auditBase, approverEmail: guard.operator.email, approvalId: approval.id },
		"ok",
		`minted approval ${approval.id} (expires ${approval.expires_at.toISOString()})`,
	);

	return json(
		{
			approvalId: approval.id,
			action,
			resourceId: parsed.data.resourceId,
			expiresAt: approval.expires_at,
			approver: guard.operator.email,
			note: "The acting operator must be a DIFFERENT person than the approver.",
		},
		201,
	);
}
