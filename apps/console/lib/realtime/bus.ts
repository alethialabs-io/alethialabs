// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { Actor } from "@/lib/authz/types";
import { log } from "@/lib/observability/log";
import { type ChangeTransport, type ChangeValue, getChangeTransport } from "./index";
import { PdpMemo } from "./pdp-memo";
import { type ChangeNotice, hintOf, keysFor } from "./routing";
import type { Hint, ResyncReason } from "./topics";

const blog = log.child({ component: "realtime-bus" });

/** What a stream does with what the bus hands it. Both are synchronous: the stream buffers. */
export interface StreamSink {
	/** One hint for this stream. */
	hint(hint: Hint): void;
	/** Invalidate everything this stream's client shows. */
	resync(reason: ResyncReason): void;
}

/** One stream's registration with the bus. */
export interface Subscription {
	/** Replace the actor and the keys (a re-authorisation ran). Tells the stream to resync if the keys changed. */
	update(actor: Actor, keys: readonly string[]): void;
	/** Leave the bus. Idempotent. */
	close(): void;
}

/** The bus's counters, reported by the self-test loop to /health (the leak counter is `streams`). */
export interface BusStats {
	streams: number;
	keys: number;
	/** People with at least one open stream in this process. */
	users: number;
	/** The most streams any one person holds open in this process (at most the per-user cap). */
	maxPerUser: number;
	delivered: number;
	filtered: number;
	dropped: number;
	/** Streams refused because their user already held the per-user cap. */
	refused: number;
}

/**
 * How many streams one person may hold open in one process, by default. PR B's leader tab opens one
 * per browser per org, so a person reaches this only with many browsers or orgs open at once.
 * `ALETHIA_REALTIME_MAX_STREAMS_PER_USER` overrides it (scripts/bench-realtime.mjs opens many streams
 * on one session).
 */
export const MAX_STREAMS_PER_USER = 8;

/** The per-user cap: the env override when it is a positive integer, else {@link MAX_STREAMS_PER_USER}. */
export function maxStreamsPerUser(): number {
	const n = Number(process.env.ALETHIA_REALTIME_MAX_STREAMS_PER_USER);
	return Number.isInteger(n) && n > 0 ? n : MAX_STREAMS_PER_USER;
}

/**
 * How many deliveries to one stream may wait on a PDP answer. Past this the stream's waiting hints
 * are dropped and it is sent one `resync` once its queue has drained; the read path covers what was
 * dropped.
 */
export const MAX_PENDING_PER_STREAM = 32;

interface Sub {
	actor: Actor;
	keys: readonly string[];
	readonly sink: StreamSink;
	closed: boolean;
	/** Deliveries waiting on a PDP answer, in notice order; null when none are. */
	queue: Promise<void> | null;
	inflight: number;
	/** True from an overflow until the queue drains; deliveries are dropped meanwhile. */
	overflowed: boolean;
}

/**
 * The change bus (#6115, ADR 0005 D3): ONE `alethia_change` LISTEN per process, fanned out to every
 * open `/{org}/~/events` stream by routing key.
 *
 * Per notice it finds each stream on any of the notice's keys ONCE, however many of its keys matched,
 * and delivers the hint — straight away when the stream matched through an unfiltered arm, after the
 * PDP's `view` on the project when it matched only through the org arm (lib/realtime/routing.ts says
 * why). Deliveries to one stream stay in notice order even when one of them waits on the PDP, and at
 * most {@link MAX_PENDING_PER_STREAM} may wait.
 *
 * What it does not do: buffer, or number anything. A stream that cannot keep up drops its pending
 * hints and is told to resync (the route), and each stream keeps its own cursor of what it sent.
 */
export class ChangeBus {
	private readonly byKey = new Map<string, Set<Sub>>();
	private readonly subs = new Set<Sub>();
	private readonly perUser = new Map<string, number>();
	private readonly selfTests = new Map<string, () => void>();
	private readonly transport: Pick<ChangeTransport, "tap" | "onReconnect">;
	readonly memo: PdpMemo;
	private readonly maxPerUser: number;
	private started = false;
	private delivered = 0;
	private filtered = 0;
	private dropped = 0;
	private refused = 0;

	constructor(deps: {
		transport: Pick<ChangeTransport, "tap" | "onReconnect">;
		memo?: PdpMemo;
		maxStreamsPerUser?: number;
	}) {
		this.transport = deps.transport;
		this.memo = deps.memo ?? new PdpMemo();
		this.maxPerUser = deps.maxStreamsPerUser ?? MAX_STREAMS_PER_USER;
	}

	/** Attach to the transport (opens the LISTEN). Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.transport.tap((value) => this.receive(value));
		this.transport.onReconnect(() => this.resyncAll("reconnect"));
	}

	/** True when `userId` may open another stream in this process. */
	hasRoomFor(userId: string): boolean {
		return (this.perUser.get(userId) ?? 0) < this.maxPerUser;
	}

	/**
	 * Register a stream, or return null when `actor.userId` already holds the per-user cap here (the
	 * route answers 429). Starts the bus.
	 */
	subscribe(actor: Actor, keys: readonly string[], sink: StreamSink): Subscription | null {
		this.start();
		const userId = actor.userId;
		if (!this.hasRoomFor(userId)) {
			this.refused += 1;
			return null;
		}
		this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
		const sub: Sub = {
			actor,
			keys: [],
			sink,
			closed: false,
			queue: null,
			inflight: 0,
			overflowed: false,
		};
		this.subs.add(sub);
		this.index(sub, keys);
		return {
			update: (nextActor, nextKeys) => {
				if (sub.closed) return;
				sub.actor = nextActor;
				const changed =
					nextKeys.length !== sub.keys.length ||
					nextKeys.some((k) => !sub.keys.includes(k));
				if (!changed) return;
				this.unindex(sub);
				this.index(sub, nextKeys);
				// The stream may now be owed rows it was not routed before: one resync settles it.
				sub.sink.resync("keys-changed");
			},
			close: () => {
				if (sub.closed) return;
				sub.closed = true;
				this.unindex(sub);
				this.subs.delete(sub);
				const left = (this.perUser.get(userId) ?? 1) - 1;
				if (left > 0) this.perUser.set(userId, left);
				else this.perUser.delete(userId);
			},
		};
	}

	/** Note a stream refused before it reached {@link subscribe} (the route's 429). */
	noteRefused(): void {
		this.refused += 1;
	}

	/** Tell every stream to invalidate everything (a LISTEN reconnect: notices may have been missed). */
	resyncAll(reason: ResyncReason): void {
		blog.info("resync broadcast", { reason, streams: this.subs.size });
		for (const sub of this.subs) sub.sink.resync(reason);
	}

	/** A stream dropped `n` hints it could not send (backpressure). */
	noteDropped(n: number): void {
		this.dropped += n;
	}

	/** Forget the PDP answers about `userId` (their stream just re-authorised). */
	evictUser(userId: string): void {
		this.memo.evictUser(userId);
	}

	/**
	 * Resolves true when a self-test notice carrying `nonce` arrives on the LISTEN connection, false
	 * after `timeoutMs`. Starts the bus.
	 */
	awaitSelfTest(nonce: string, timeoutMs: number): Promise<boolean> {
		this.start();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.selfTests.delete(nonce);
				resolve(false);
			}, timeoutMs);
			this.selfTests.set(nonce, () => {
				clearTimeout(timer);
				this.selfTests.delete(nonce);
				resolve(true);
			});
		});
	}

	/** The counters (streams, keys, users and maxPerUser are live; the rest are totals since boot). */
	stats(): BusStats {
		let maxPerUser = 0;
		for (const n of this.perUser.values()) maxPerUser = Math.max(maxPerUser, n);
		return {
			streams: this.subs.size,
			keys: this.byKey.size,
			users: this.perUser.size,
			maxPerUser,
			delivered: this.delivered,
			filtered: this.filtered,
			dropped: this.dropped,
			refused: this.refused,
		};
	}

	/** One notice from the transport. */
	receive(value: ChangeValue): void {
		if (value.kind === "selftest") {
			// Consumed by its issuer only. A nonce this process did not send (another replica's) is ignored.
			this.selfTests.get(value.nonce)?.();
			return;
		}
		this.dispatch(value);
	}

	private dispatch(notice: ChangeNotice): void {
		const routes = keysFor(notice);
		if (routes.length === 0) return;
		// Each stream once per notice; an unfiltered arm wins over a filtered one.
		const matched = new Map<Sub, string | null>();
		for (const route of routes) {
			const subs = this.byKey.get(route.key);
			if (!subs) continue;
			for (const sub of subs) {
				if (!matched.has(sub) || route.filterProject === null) {
					matched.set(sub, route.filterProject);
				}
			}
		}
		if (matched.size === 0) return;
		const hint = hintOf(notice);
		for (const [sub, project] of matched) this.offer(sub, hint, project);
	}

	/** Deliver `hint` to `sub` if it passes the filter, in order with anything already queued. */
	private offer(sub: Sub, hint: Hint, project: string | null): void {
		if (sub.overflowed) {
			this.dropped += 1;
			return;
		}
		const known = project === null ? true : this.memo.peek(sub.actor, project);
		if (sub.queue === null && known !== undefined) {
			this.settle(sub, hint, known);
			return;
		}
		if (sub.inflight >= MAX_PENDING_PER_STREAM) {
			// Stop waiting: what is queued is dropped as it settles, and the stream resyncs once drained.
			sub.overflowed = true;
			this.dropped += 1;
			return;
		}
		sub.inflight += 1;
		const previous = sub.queue ?? Promise.resolve();
		sub.queue = previous
			.then(async () => {
				if (sub.overflowed) {
					this.dropped += 1;
					return;
				}
				const allowed =
					known ?? (project === null ? true : await this.memo.allowed(sub.actor, project));
				if (sub.overflowed) {
					this.dropped += 1;
					return;
				}
				this.settle(sub, hint, allowed);
			})
			.catch((err) => blog.error("hint delivery failed", { err }))
			.finally(() => {
				sub.inflight -= 1;
				if (sub.inflight > 0) return;
				sub.queue = null;
				if (!sub.overflowed) return;
				sub.overflowed = false;
				if (!sub.closed) sub.sink.resync("backpressure");
			});
	}

	private settle(sub: Sub, hint: Hint, allowed: boolean): void {
		if (sub.closed) return;
		if (!allowed) {
			this.filtered += 1;
			return;
		}
		this.delivered += 1;
		sub.sink.hint(hint);
	}

	private index(sub: Sub, keys: readonly string[]): void {
		sub.keys = [...new Set(keys)];
		for (const key of sub.keys) {
			let set = this.byKey.get(key);
			if (!set) {
				set = new Set();
				this.byKey.set(key, set);
			}
			set.add(sub);
		}
	}

	private unindex(sub: Sub): void {
		for (const key of sub.keys) {
			const set = this.byKey.get(key);
			if (!set) continue;
			set.delete(sub);
			if (set.size === 0) this.byKey.delete(key);
		}
	}
}

declare global {
	var __alethiaChangeBus: ChangeBus | undefined;
}

/** The process-wide change bus (HMR/instance-safe singleton) over the `alethia_change` transport. */
export function getChangeBus(): ChangeBus {
	globalThis.__alethiaChangeBus ??= new ChangeBus({
		transport: getChangeTransport(),
		maxStreamsPerUser: maxStreamsPerUser(),
	});
	return globalThis.__alethiaChangeBus;
}
