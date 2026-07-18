// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/breakglass/execute — the SINGLE audited action-execution endpoint. Every privileged
// break-glass action (inspect/retry/cancel job, unstick env, drain/restart runner, replay webhook,
// force-release state lock, state surgery, orphan detect/clean) flows through here, behind the gate
// and the dispatcher's full invariant chain. Having exactly one mutation entry point is what makes
// "the RLS-bypassing surface is unreachable without the gate" true by construction.

import {
	executeBreakglassAction,
	type BreakglassCommand,
} from "@/lib/breakglass/actions";
import { guardBreakglass, json } from "@/lib/breakglass/guard";
import { executeSchema } from "@/lib/validations/breakglass";

export async function POST(req: Request): Promise<Response> {
	const guard = await guardBreakglass(req);
	if ("error" in guard) return guard.error;

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}
	const parsed = executeSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
	}

	const result = await executeBreakglassAction(
		guard.operator,
		parsed.data,
	);
	if (!result.ok) {
		return json({ error: result.message }, result.code);
	}
	return json({ ok: true, detail: result.detail, data: result.data ?? null });
}
