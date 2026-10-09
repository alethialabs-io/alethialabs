// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/elench/drafts/heartbeat — the draft claim's heartbeat, `touchClaim` (ADR 0001 §3.4 S7).
//
// A ROUTE HANDLER, NEVER A SERVER ACTION (B1). Next runs every server action of a page through one
// global queue, so a heartbeat sent as an action would wait behind exactly the stall the 120 s lease
// exists to survive, and a live claim would then be settled as if its sender were dead. A `fetch`
// to a route handler never enters that queue. From slice 8, the client's heartbeat timer will call
// this route every 20 s while it holds a granted claim.
//
// The guard, in order: the session's user (401 without one; the user is NEVER read from the body);
// `Content-Type: application/json` (415); zod on `{ orgId, conversationId, token }` (400); the
// per-user rate limit, in the same bucket as the draft actions (429); `resolveTurnActor(userId,
// orgId)`, strictly two-way, so an org the caller is not an active member of is 403 and the claim
// then lapses by the lease. Then one `withActorScope` transaction renews `claimed_at` on the
// caller's OWN row, only while it is `sending` under exactly this token.
//
// It never settles a claim, with any token: S7 only renews. (The lease settle's own rule is that a
// request presenting the row's LIVE token never ends that claim by the lease; `consumeDraft` and
// `releaseClaim` presenting a stale token may settle a silent claim. This route does neither.)
//
// Cross-site requests. A route handler has no server action's origin check. Three things stand in
// for it: Better Auth's session cookie is `SameSite=Lax` (its default, not overridden in
// lib/auth/index.ts), so a cross-site POST arrives without a session and is 401; the JSON
// content-type requirement makes any cross-origin request non-simple, so a browser preflights it;
// and the renewal needs the claim token, a random UUID held only in the owner's own rows, and at
// worst would renew the owner's own live claim.

import { z } from "zod";
import { getOwner } from "@/lib/auth/owner";
import { resolveTurnActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { touchClaim } from "@/lib/elench/draft-claims";
import {
	DRAFT_RATE_LIMIT,
	DRAFT_RATE_WINDOW_MS,
	draftRateKey,
	isDatabaseError,
} from "@/lib/elench/draft-gate";
import { errorName } from "@/lib/errors";
import { log } from "@/lib/observability/log";
import { checkRateLimit } from "@/lib/rate-limit";

const hlog = log.child({ component: "elench-drafts-heartbeat" });

const heartbeatSchema = z.object({
	orgId: z.uuid(),
	conversationId: z.uuid(),
	token: z.uuid(),
});

/** The heartbeat's input: the key's org and conversation, and the claim's token. */
export type HeartbeatInput = z.input<typeof heartbeatSchema>;

/** True when the request declares a JSON body (`application/json`, parameters allowed). */
function isJson(req: Request): boolean {
	const type = req.headers.get("content-type") ?? "";
	return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * Renews the caller's draft claim (S7). 200 with `touched`, `not-claimed(row, thread)` or
 * `gone(thread)`; 400, 401, 403, 415 and 429 refuse and write nothing; 503 when a database read or
 * write behind the session failed (the org resolution or the renewal). The rate limiter fails
 * closed on its own database error, so that case answers 429.
 */
export async function POST(req: Request): Promise<Response> {
	const userId = await getOwner();
	if (!userId) return new Response("Unauthorized", { status: 401 });
	if (!isJson(req)) return new Response("Expected application/json.", { status: 415 });

	const parsed = heartbeatSchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) return new Response("Invalid heartbeat.", { status: 400 });
	const { orgId, conversationId, token } = parsed.data;

	try {
		const rate = await checkRateLimit(draftRateKey(userId), DRAFT_RATE_LIMIT, DRAFT_RATE_WINDOW_MS);
		if (!rate.ok) return new Response("Too many requests.", { status: 429 });

		const actor = await resolveTurnActor(userId, orgId);
		if (!actor) return new Response("Forbidden", { status: 403 });

		const result = await withActorScope(actor, (tx) =>
			touchClaim(tx, actor, conversationId, token),
		);
		return Response.json(result);
	} catch (e) {
		if (!isDatabaseError(e)) throw e;
		// The name only: a driver error's message can quote the statement's parameters, which here
		// include the claim token.
		hlog.error("draft heartbeat database error", { error: errorName(e) });
		return new Response("Unavailable", { status: 503 });
	}
}
