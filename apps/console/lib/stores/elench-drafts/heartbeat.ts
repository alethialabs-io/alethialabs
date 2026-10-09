// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft claim's heartbeat timer (ADR 0001 §3.4 S7, D34).
//
// One timer per GRANTED claim: a key whose `sending` carries a token. It starts when the store
// first sees that token (`claimed-by-you`, D9b / D10b) and stops when `sending` clears or changes
// token. It never runs while a claim is only `claiming`: a heartbeat sent then could overtake the
// `claimDraft` it would renew and answer `not-claimed` for a claim about to land (B1'). The store
// derives the set of granted claims from its state after every dispatch and hands it to `sync`.
//
// Each beat is a `fetch` to `POST /api/elench/drafts/heartbeat`, NEVER a server action, so it runs
// outside the per-key queue and outside Next's one global action queue (I10, B1): a stalled or
// abandoned action cannot starve it. Every 20 s, at once on `visibilitychange: visible`, with a 10 s
// fetch timeout of its own. A 200's body is validated and handed back as `HEARTBEAT_RESULT`, which
// the reducer reads only in `routing` under the same token (D34). A 401 or 403 stops the timer for
// that claim (the session ended, or the org refused the caller) and the lease settles it; a 429 or
// any other failure is simply tried again at the next tick.

import { z } from "zod";
import { contentSchema } from "@/lib/elench/draft-content";
import type { TouchClaimResult } from "@/lib/elench/draft-outcomes";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";

/** How often a granted claim is renewed (Q12). */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** The heartbeat's own fetch timeout (D34). */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** The route the heartbeat posts to (slice 4). */
export const HEARTBEAT_PATH = "/api/elench/drafts/heartbeat";

/** The heartbeat's body: the key's org and conversation, and the claim's token. */
export interface HeartbeatBody {
	orgId: string;
	conversationId: string;
	token: string;
}

/** Sends one heartbeat; `signal` aborts it at the fetch timeout. */
export type HeartbeatSend = (body: HeartbeatBody, signal: AbortSignal) => Promise<Response>;

/** One granted claim the timer keeps alive. */
export interface GrantedClaim {
	key: DraftKey;
	token: string;
}

const kindSchema = z.enum(["first", "later"]);

const threadSchema = z.object({
	status: z.enum(["none", "unlisted", "listed", "deleted"]),
	firstTurnId: z.string().nullable(),
	hasTurn: z.boolean(),
});

const rowSchema = z.object({
	orgId: z.string(),
	projectId: z.string().nullable(),
	conversationId: z.string(),
	revision: z.number().int(),
	state: z.enum(["active", "sending", "discarded"]),
	content: contentSchema,
	claim: z
		.object({ token: z.string(), turnId: z.string(), kind: kindSchema, claimedAt: z.string() })
		.nullable(),
	failedSend: z
		.object({
			turnId: z.string().nullable(),
			kind: kindSchema,
			error: z.string(),
			at: z.string(),
			uncertain: z.boolean(),
		})
		.nullable(),
	lastSent: z.object({ turnId: z.string(), kind: kindSchema, at: z.string() }).nullable(),
	threadSeen: z.boolean(),
	title: z.string().nullable(),
	lastWriter: z.string().nullable(),
	discardedAt: z.string().nullable(),
	updatedAt: z.string(),
});

/** A 200's body (§4.2). */
const touchResultSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("touched") }),
	z.object({ outcome: z.literal("not-claimed"), row: rowSchema, thread: threadSchema }),
	z.object({ outcome: z.literal("gone"), thread: threadSchema }),
]);

/** The heartbeat over the browser's own `fetch`, which never enters Next's action queue. */
export function fetchHeartbeat(fetchImpl: typeof fetch = fetch): HeartbeatSend {
	return (body, signal) =>
		fetchImpl(HEARTBEAT_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			credentials: "same-origin",
			body: JSON.stringify(body),
			signal,
		});
}

/** The timers of every granted claim of this tab. */
export class ClaimHeartbeats {
	private timers = new Map<string, { claim: GrantedClaim; timer: ReturnType<typeof setInterval> }>();
	/** Tokens whose heartbeat a 401 or 403 stopped; never restarted. */
	private stopped = new Set<string>();

	/** `onResult` receives a 200's validated body for the claim the beat carried. */
	constructor(
		private readonly send: HeartbeatSend,
		private readonly onResult: (claim: GrantedClaim, result: TouchClaimResult) => void,
	) {}

	/** Runs exactly one timer per granted claim in `claims`, and none for any other token. */
	sync(claims: readonly GrantedClaim[]): void {
		const want = new Map(claims.map((c) => [c.token, c]));
		for (const [token, t] of this.timers)
			if (!want.has(token)) {
				clearInterval(t.timer);
				this.timers.delete(token);
			}
		for (const [token, claim] of want) {
			if (this.timers.has(token) || this.stopped.has(token)) continue;
			const timer = setInterval(() => void this.beat(claim), HEARTBEAT_INTERVAL_MS);
			this.timers.set(token, { claim, timer });
		}
	}

	/** D34: at once on `visibilitychange: visible`, for every granted claim. */
	beatAll(): void {
		for (const { claim } of this.timers.values()) void this.beat(claim);
	}

	/** Stops every timer (the store is disposed, or the viewer changed). */
	stopAll(): void {
		for (const t of this.timers.values()) clearInterval(t.timer);
		this.timers.clear();
	}

	/** One heartbeat; its answer goes to `onResult`, a 401/403 stops this claim's timer. */
	private async beat(claim: GrantedClaim): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
		try {
			const body = {
				orgId: claim.key.orgId,
				conversationId: claim.key.conversationId,
				token: claim.token,
			};
			const res = await this.send(body, controller.signal);
			if (res.status === 401 || res.status === 403) {
				this.stopped.add(claim.token);
				const t = this.timers.get(claim.token);
				if (t !== undefined) clearInterval(t.timer);
				this.timers.delete(claim.token);
				return;
			}
			if (!res.ok) return; // 429 and the rest: the next tick tries again
			const parsed = touchResultSchema.safeParse(await res.json());
			if (parsed.success) this.onResult(claim, parsed.data);
		} catch {
			// a network failure or the fetch timeout: the next tick tries again
		} finally {
			clearTimeout(timeout);
		}
	}
}
