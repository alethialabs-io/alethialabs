// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/breakglass/session — open a time-boxed, audited break-glass session. Behind the
// break-glass gate (feature-flag + operator allowlist). Opening a session is itself audited.

import { guardBreakglass, json, requestProvenance } from "@/lib/breakglass/guard";
import { openBreakglassSession } from "@/lib/breakglass/session";
import { openSessionSchema } from "@/lib/validations/breakglass";

export async function POST(req: Request): Promise<Response> {
	const guard = await guardBreakglass(req);
	if ("error" in guard) return guard.error;

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}
	const parsed = openSessionSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
	}

	const session = await openBreakglassSession(
		guard.operator,
		parsed.data.reason,
		requestProvenance(req),
	);
	return json(
		{ sessionId: session.id, expiresAt: session.expires_at, operator: guard.operator.email },
		201,
	);
}
