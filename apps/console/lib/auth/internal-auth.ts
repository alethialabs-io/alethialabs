// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared platform-internal request authorization — the `Authorization: Bearer ${ALETHIA_CRON_SECRET}`
// convention already used by the maintenance/cron endpoints (alerts / drift / connections sweeps,
// cloud-event forwarder). Centralised here so the deep-health gate mirrors that exact scheme rather
// than inventing a new one. Fail-closed: an UNSET secret means nobody is internally authorized (never
// "open"), and the compare is constant-time so a token can't be recovered by timing the response.

import { timingSafeEqual } from "node:crypto";

/** Constant-time string equality (length mismatch short-circuits — token length is not itself secret). */
function constantTimeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * True when the request carries the platform-internal bearer secret (`ALETHIA_CRON_SECRET`). Returns
 * false when the secret is unset (fail-closed — the caller must treat "not configured" as "not
 * privileged", never as open) or the header is missing/wrong. The comparison is constant-time.
 */
export function isInternalAuthorized(req: Request): boolean {
	const secret = process.env.ALETHIA_CRON_SECRET;
	if (!secret) return false;
	const header = req.headers.get("authorization");
	if (!header) return false;
	return constantTimeEqual(header, `Bearer ${secret}`);
}
