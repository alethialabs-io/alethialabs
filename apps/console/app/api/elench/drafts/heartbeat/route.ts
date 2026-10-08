// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/elench/drafts/heartbeat — the draft claim's heartbeat, `touchClaim` (ADR 0001 §3.4 S7).
//
// A ROUTE HANDLER, NEVER A SERVER ACTION (B1). Next runs every server action of a page through one
// global queue, so a heartbeat sent as an action waits behind exactly the stall the 120 s lease
// exists to survive, and a live tab's claim is then settled as if the tab were dead. A `fetch` to a
// route handler never enters that queue.
//
// The guard, in order: the session's user (401 without one; the user is NEVER read from the body);
// zod on `{ orgId, conversationId, token }` (400); the per-user rate limit, in the same bucket as the
// draft actions (429); `resolveTurnActor(userId, orgId)`, strictly two-way, so an org the caller is
// not an active member of is 403 and the claim then lapses by the lease. Then one `withActorScope`
// transaction renews `claimed_at` on the caller's OWN row, only while it is `sending` under exactly
// this token. It never settles a claim: this request presents a token, and a request that presents
// one never ends a claim by the lease (S5).
//
// A route handler has no server action's origin check. A forged cross-site POST would need the claim
// token, a random UUID that lives only in the owner's rows and tab, and at worst it renews the
// owner's own live claim.

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

/**
 * Renews the caller's draft claim (S7). 200 with `touched`, `not-claimed(row, thread)` or
 * `gone(thread)`; 400, 401, 403 and 429 refuse and write nothing; 503 when the database failed.
 */
export async function POST(req: Request): Promise<Response> {
	const userId = await getOwner();
	if (!userId) return new Response("Unauthorized", { status: 401 });

	const parsed = heartbeatSchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) return new Response("Invalid heartbeat.", { status: 400 });
	const { orgId, conversationId, token } = parsed.data;

	const rate = await checkRateLimit(draftRateKey(userId), DRAFT_RATE_LIMIT, DRAFT_RATE_WINDOW_MS);
	if (!rate.ok) return new Response("Too many requests.", { status: 429 });

	const actor = await resolveTurnActor(userId, orgId);
	if (!actor) return new Response("Forbidden", { status: 403 });

	try {
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
