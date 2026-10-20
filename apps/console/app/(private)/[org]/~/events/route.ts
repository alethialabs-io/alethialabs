// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import { UnauthorizedError } from "@/lib/auth/errors";
import { namesNoOrg } from "@/lib/authz/org-path";
import { urlScopedOrgId } from "@/lib/authz/org-scope";
import { currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";
import { errorDigest } from "@/lib/errors";
import { holdRequest } from "@/lib/http/hold-request";
import { log } from "@/lib/observability/log";
import { bootId } from "@/lib/realtime/boot";
import { getChangeBus, type StreamSink, type Subscription } from "@/lib/realtime/bus";
import { capabilitiesOf, reauthorize, type StreamSnapshot } from "@/lib/realtime/reauth";
import { subscriptionKeys } from "@/lib/realtime/routing";
import { startRealtimeBus } from "@/lib/realtime/self-test";
import {
	EVENT_STREAM_HEADERS,
	HEARTBEAT_FRAME,
	helloFrame,
	hintFrame,
	resyncFrame,
	retryDelayMs,
	retryFrame,
	revokedFrame,
} from "@/lib/realtime/sse";
import type { Hint, ResyncReason } from "@/lib/realtime/topics";

// One stream per tab (leader tab per browser, PR B); nothing here is cacheable by anyone.
export const dynamic = "force-dynamic";

const elog = log.child({ component: "realtime-events" });

/** Heartbeat cadence; every {@link REAUTH_EVERY}th beat also re-authorises (60 s). */
const HEARTBEAT_MS = 20_000;
const REAUTH_EVERY = 3;

/** How long one re-authorisation may take; past it the stream ends with `revoked`. */
const REAUTH_TIMEOUT_MS = 10_000;

/** What a 429 tells the client to wait before trying again (seconds). */
const RETRY_AFTER_S = 30;

/**
 * How many bytes a stream may have queued and unread before it stops being sent hints and is told
 * to resync instead. Bounds the memory a stalled client can pin to ~64 KB (ADR 0005 §5).
 */
const STREAM_HIGH_WATER_BYTES = 64 * 1024;

/** The per-person stream cap's answer: 429 with Retry-After. */
function tooManyStreams(): Response {
	return Response.json(
		{ error: "Too many open live-update streams" },
		{
			status: 429,
			headers: { "Cache-Control": "private, no-store", "Retry-After": String(RETRY_AFTER_S) },
		},
	);
}

/** A refusal with no internals in it. */
function refusal(status: number, error: string): Response {
	return Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Resolves the caller for this address exactly as the read router does (`/{org}/~/rpc`): the
 * ADDRESS decides the tenant, a non-member is answered exactly as an unknown org (404), no session
 * is a 401, a resolver that lands elsewhere is a 403. Returns the
 * refusal instead of the actor when there is one.
 */
async function resolveCaller(pathname: string): Promise<Actor | Response> {
	if (!pathname.endsWith("/~/events")) return refusal(404, "Not found");
	// `/docs/~/events`, `/start/~/events`, … name no org, and `currentActor()` would fall back to the
	// SESSION's org there. The bus has no org-less mount, so they are simply not found.
	if (namesNoOrg(pathname)) return refusal(404, "Not found");
	try {
		return await currentActor();
	} catch (error) {
		if ((errorDigest(error) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
			return refusal(404, "Not found");
		}
		if (error instanceof UnauthorizedError) return refusal(401, "Unauthorized");
		if (error instanceof ForbiddenError) return refusal(403, "Forbidden");
		throw error;
	}
}

/**
 * `GET /{org}/~/events` and `/~/~/events` — the console's change stream (#6115, ADR 0005 D3).
 *
 * Sends invalidation hints `{t, id}` for rows the caller could read in this org, a `resync` when the
 * server may have missed some, a `:` heartbeat every 20 s, and — every 60 s — re-checks the session,
 * the membership and the Terms, ending the stream with `revoked` when one of them is gone.
 *
 * `?probe=1` answers 204 after the same checks, for a client whose stream closed to learn WHY:
 * EventSource-style reconnects cannot see a status code (ADR 0005 §10 R7).
 *
 * A route handler never runs the `[org]` layout, so nothing here writes the session's active org.
 */
export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const resolved = await resolveCaller(url.pathname);
	if (resolved instanceof Response) return resolved;
	const actor = resolved;

	// The clickwrap gate (#2372). The private layout enforces it for pages and never runs here.
	if (!(await hasAcceptedCurrentDocuments(actor.userId))) {
		return refusal(403, "Accept the current Terms to continue.");
	}

	if (url.searchParams.get("probe") === "1") {
		// The probe answers what a new stream would get, the per-person cap included, so a client that
		// could not see a refused stream's status backs off on Retry-After rather than on `retry:`.
		if (!getChangeBus().hasRoomFor(actor.userId)) return tooManyStreams();
		return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
	}

	// The org the ADDRESS named (`currentActor()` just proved active membership of it). In the
	// single-tenant edition the actor is the personal scope even for an org address, so the actor's
	// orgId is not this; re-authorisation re-checks membership of THIS org.
	const addressOrgId = (await urlScopedOrgId(actor.userId)) ?? actor.orgId;
	const snapshot: StreamSnapshot = {
		userId: actor.userId,
		addressOrgId,
		cookie: request.headers.get("cookie") ?? "",
	};
	const caps = await capabilitiesOf(actor);

	startRealtimeBus(); // a no-op when instrumentation.ts already started it
	const bus = getChangeBus();
	const keys = subscriptionKeys(actor, caps);

	// One person's streams per process are capped (PR B opens one per browser per org).
	if (!bus.hasRoomFor(actor.userId)) {
		bus.noteRefused();
		return tooManyStreams();
	}

	// The stream's cursor: opaque, and it moves only when THIS stream is sent an event. A random tag
	// per stream, so a reconnect never compares equal to a previous stream and always resyncs, and a
	// count of the events sent on it. The client only ever compares two cursors for equality.
	const streamTag = randomBytes(6).toString("base64url");
	let sent = 0;
	const nextCursor = () => {
		sent += 1;
		return `${streamTag}.${sent.toString(36)}`;
	};

	// The client's disconnect, read once here. The `Request` must stay reachable while the stream runs:
	// its signal stops following the disconnect once the `Request` is collected, and nothing below
	// reads `request` again except the `holdRequest` in teardown (see lib/http/hold-request.ts).
	const signal = request.signal;
	const encoder = new TextEncoder();
	let subscription: Subscription | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				/** Tear the stream down: stop its work, then end the body. */
				const stop = () => {
					cleanup();
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				};
				const write = (text: string) => {
					if (!closed) controller.enqueue(encoder.encode(text));
				};
				const congested = () => (controller.desiredSize ?? 0) <= 0;

				// Hints are coalesced per (topic, id) and written once per microtask, so a burst of one
				// row's changes is one frame. A stream that is not being read drops them and owes a resync.
				const pending = new Map<string, Hint>();
				let flushQueued = false;
				let owesResync = false;
				const flush = () => {
					flushQueued = false;
					if (closed) return;
					if (congested()) {
						if (pending.size > 0) {
							bus.noteDropped(pending.size);
							pending.clear();
							owesResync = true;
						}
						return;
					}
					if (owesResync) {
						owesResync = false;
						pending.clear();
						write(resyncFrame("backpressure", nextCursor()));
						return;
					}
					if (pending.size === 0) return;
					const hints = [...pending.values()];
					pending.clear();
					write(hints.map((h) => hintFrame(h, nextCursor())).join(""));
				};
				const schedule = () => {
					if (flushQueued) return;
					flushQueued = true;
					queueMicrotask(flush);
				};
				const sink: StreamSink = {
					hint(hint) {
						if (closed) return;
						const key = `${hint.t}|${hint.id ?? ""}`;
						pending.delete(key);
						pending.set(key, hint);
						schedule();
					},
					resync(reason: ResyncReason) {
						if (closed) return;
						pending.clear();
						if (congested()) {
							owesResync = true;
							return;
						}
						write(resyncFrame(reason, nextCursor()));
					},
				};

				let reauthorising = false;
				const recheck = async () => {
					let result: Awaited<ReturnType<typeof reauthorize>> | "timeout";
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						result = await Promise.race([
							reauthorize(snapshot),
							new Promise<"timeout">((resolve) => {
								timer = setTimeout(() => resolve("timeout"), REAUTH_TIMEOUT_MS);
							}),
						]);
					} catch (err) {
						// Not a revocation and not a pass: end the stream; the reconnect re-runs the connect path.
						elog.warn("stream re-authorisation failed; closing the stream", { err });
						stop();
						return;
					} finally {
						clearTimeout(timer);
					}
					if (closed) return;
					if (result === "timeout") {
						// Not a pass and not a revocation (`revoked` is terminal for the client): end the
						// stream like a failed lookup, and the reconnect re-runs the connect path.
						elog.warn("stream re-authorisation timed out; closing the stream", {
							timeoutMs: REAUTH_TIMEOUT_MS,
						});
						stop();
						return;
					}
					if (!result.ok) {
						write(revokedFrame(result.reason));
						stop();
						return;
					}
					bus.evictUser(result.actor.userId);
					subscription?.update(result.actor, subscriptionKeys(result.actor, result.caps));
				};

				write(retryFrame(retryDelayMs()));
				write(helloFrame(bootId(), `${streamTag}.0`));
				// A client that left before this point aborted before the listener below existed, and an
				// abort listener never hears an abort that already happened. Stop here, before the
				// subscription and the heartbeat exist; `closed` covers a `cancel()` in the same gap.
				if (signal.aborted || closed) {
					stop();
					return;
				}
				subscription = bus.subscribe(actor, keys, sink);
				if (!subscription) {
					stop(); // the per-user cap was reached between the check above and here
					return;
				}

				let beats = 0;
				heartbeat = setInterval(() => {
					if (closed) return;
					beats += 1;
					write(HEARTBEAT_FRAME);
					if (owesResync) schedule();
					if (beats % REAUTH_EVERY === 0 && !reauthorising) {
						reauthorising = true;
						void recheck().finally(() => {
							reauthorising = false;
						});
					}
				}, HEARTBEAT_MS);

				signal.addEventListener("abort", stop);
			},
			cancel() {
				cleanup();
			},
		},
		{ highWaterMark: STREAM_HIGH_WATER_BYTES, size: (chunk) => chunk.byteLength },
	);

	/** Stop the stream's work: the heartbeat and the bus subscription. Runs once. */
	function cleanup() {
		// Keeps `request` reachable — and so `signal` live — until the stream is torn down.
		holdRequest(request);
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		subscription?.close();
	}

	return new Response(stream, { headers: EVENT_STREAM_HEADERS });
}
