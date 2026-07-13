// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared platform-internal request authorization — the `Authorization: Bearer ${secret}` convention
// used by every platform-internal endpoint: the maintenance/cron sweepers (alerts / drift /
// connections) + the cloud-event forwarder + the deep-health gate share `ALETHIA_CRON_SECRET`; the
// release publishers use `RELEASE_API_SECRET`; the runner bootstrap fallback uses a raw shared token.
// Centralised so every one of them compares the presented secret the SAME way — fail-closed and in
// CONSTANT TIME. Fail-closed: an UNSET secret means nobody is authorized (never "open"). Constant-time:
// a `!==` on a secret leaks its bytes through response timing; `timingSafeStrEqual` does not.

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. A length mismatch short-circuits to false (a token's LENGTH is not
 * itself secret, and `timingSafeEqual` throws on unequal-length buffers). An empty/undefined expected
 * value is never equal — callers pass an unset env var straight through and get a fail-closed false.
 */
export function timingSafeStrEqual(a: string, b: string | undefined | null): boolean {
	if (!b) return false;
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * True when the request's `Authorization` header is exactly `Bearer ${secret}`, compared in constant
 * time. Fail-closed: an unset/empty `secret` (an unconfigured feature) or a missing header ⇒ false,
 * never "open". The generic primitive behind every bearer-guarded internal route; pass the relevant
 * env secret (`ALETHIA_CRON_SECRET`, `RELEASE_API_SECRET`, …).
 */
export function bearerMatches(req: Request, secret: string | undefined | null): boolean {
	if (!secret) return false;
	const header = req.headers.get("authorization");
	if (!header) return false;
	return timingSafeStrEqual(header, `Bearer ${secret}`);
}

/**
 * True when the request carries the platform-internal bearer secret (`ALETHIA_CRON_SECRET`) — the
 * cron sweepers, cloud-event forwarder, and deep-health detail gate. Fail-closed + constant-time
 * (see {@link bearerMatches}).
 */
export function isInternalAuthorized(req: Request): boolean {
	return bearerMatches(req, process.env.ALETHIA_CRON_SECRET);
}
