// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one guard every break-glass route calls first. Fail-closed:
//   - feature off (default)                → 404 (the surface does not exist / leaks nothing), and
//   - authenticated but not an operator    → 403.
// A route CANNOT reach a handler without passing this, and there is exactly one action-execution
// endpoint behind it (execute), so the RLS-bypassing surface is unreachable without the gate.

import { resolveBreakglassOperator, type BreakglassOperator } from "./auth";
import { isBreakglassEnabled } from "./config";

export type GuardResult =
	| { operator: BreakglassOperator }
	| { error: Response };

/** Resolves + authorizes the caller, or returns a ready-to-send error Response. */
export async function guardBreakglass(req: Request): Promise<GuardResult> {
	// Master switch first: when off, return 404 so the feature is indistinguishable from absent.
	if (!isBreakglassEnabled()) {
		return { error: json({ error: "Not found" }, 404) };
	}
	const operator = await resolveBreakglassOperator(req);
	if (!operator) {
		return { error: json({ error: "Not authorized: break-glass operator only" }, 403) };
	}
	return { operator };
}

/** Best-effort request provenance for the forensic session record. */
export function requestProvenance(req: Request): {
	ip: string | null;
	userAgent: string | null;
} {
	return {
		ip:
			req.headers.get("cf-connecting-ip") ||
			req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
			null,
		userAgent: req.headers.get("user-agent"),
	};
}

/** A small JSON Response helper. */
export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
