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
	/** One hint; `cursor` is this stream's cursor as of the notice that produced it. */
	hint(hint: Hint, cursor: string): void;
	/** Invalidate everything; `cursor` is this stream's cursor now. */
	resync(reason: ResyncReason, cursor: string): void;
}

/** One stream's registration with the bus. */
export interface Subscription {
	/** Replace the actor and the keys (a re-authorisation ran). Tells the stream to resync if the keys changed. */
	update(actor: Actor, keys: readonly string[]): void;
	/** This stream's cursor now. */
	cursor(): string;
	/** Leave the bus. Idempotent. */
	close(): void;
}

/** The bus's counters, reported by the self-test loop to /health (the leak counter is `streams`). */
export interface BusStats {
	streams: number;
	keys: number;
	delivered: number;
	filtered: number;
	dropped: number;
}

/**
 * How many cursor counters exist. A stream's cursor is the sum of the counters its keys hash to, so
 * memory is fixed however many orgs and people the process ever hears about. A collision can only
 * make two cursors differ more often than they would have — a spare resync — never make them equal
 * when a notice was missed, because counters only ever go up.
 */
const CURSOR_BUCKETS = 4096;

/** FNV-1a over the key, folded onto the counter buckets. */
function bucketOf(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) % CURSOR_BUCKETS;
}

interface Sub {
	actor: Actor;
	keys: readonly string[];
	buckets: readonly number[];
	readonly sink: StreamSink;
	closed: boolean;
	/** Deliveries waiting on a PDP answer, in notice order; null when none are. */
	queue: Promise<void> | null;
	inflight: number;
}

/**
 * The change bus (#6115, ADR 0005 D3): ONE `alethia_change` LISTEN per process, fanned out to every
 * open `/{org}/~/events` stream by routing key.
 *
 * Per notice it: bumps the cursor counters of the notice's keys (whether or not anyone is listening —
 * a tab that reconnects must be able to tell it missed something); finds each stream on any of those
 * keys ONCE, however many of its keys matched; and delivers the hint — straight away when the stream
 * matched through an unfiltered arm, after the PDP's `view` on the project when it matched only
 * through the org arm (lib/realtime/routing.ts says why). Deliveries to one stream stay in notice
 * order even when one of them waits on the PDP.
 *
 * What it does not do: buffer. A stream that cannot keep up drops its pending hints and is told to
 * resync (lib/realtime/sse.ts), and the bus only counts that.
 */
export class ChangeBus {
	private readonly byKey = new Map<string, Set<Sub>>();
	private readonly subs = new Set<Sub>();
	private readonly counters = new Float64Array(CURSOR_BUCKETS);
	private readonly selfTests = new Map<string, () => void>();
	private readonly transport: Pick<ChangeTransport, "tap" | "onReconnect">;
	readonly memo: PdpMemo;
	private started = false;
	private delivered = 0;
	private filtered = 0;
	private dropped = 0;

	constructor(deps: {
		transport: Pick<ChangeTransport, "tap" | "onReconnect">;
		memo?: PdpMemo;
	}) {
		this.transport = deps.transport;
		this.memo = deps.memo ?? new PdpMemo();
	}

	/** Attach to the transport (opens the LISTEN). Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.transport.tap((value) => this.receive(value));
		this.transport.onReconnect(() => this.resyncAll("reconnect"));
	}

	/** Register a stream. Starts the bus if it is not running. */
	subscribe(actor: Actor, keys: readonly string[], sink: StreamSink): Subscription {
		this.start();
		const sub: Sub = {
			actor,
			keys: [],
			buckets: [],
			sink,
			closed: false,
			queue: null,
			inflight: 0,
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
				// The cursor domain moved with the keys, and the stream may now be owed rows it was not
				// routed before: one resync settles both.
				sub.sink.resync("keys-changed", this.cursorOf(sub));
			},
			cursor: () => this.cursorOf(sub),
			close: () => {
				if (sub.closed) return;
				sub.closed = true;
				this.unindex(sub);
				this.subs.delete(sub);
			},
		};
	}

	/** The cursor a stream holding `keys` would have now (sent in `hello` before it subscribes). */
	cursorFor(keys: readonly string[]): string {
		return String(this.sumBuckets(distinctBuckets(keys)));
	}

	/** Tell every stream to invalidate everything (a LISTEN reconnect: notices may have been missed). */
	resyncAll(reason: ResyncReason): void {
		blog.info("resync broadcast", { reason, streams: this.subs.size });
		for (const sub of this.subs) sub.sink.resync(reason, this.cursorOf(sub));
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

	/** The counters (streams and keys are live; the rest are totals since boot). */
	stats(): BusStats {
		return {
			streams: this.subs.size,
			keys: this.byKey.size,
			delivered: this.delivered,
			filtered: this.filtered,
			dropped: this.dropped,
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
		for (const b of distinctBuckets(routes.map((r) => r.key))) this.counters[b] += 1;

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
		for (const [sub, project] of matched) {
			this.offer(sub, hint, project, this.cursorOf(sub));
		}
	}

	/** Deliver `hint` to `sub` if it passes the filter, in order with anything already queued. */
	private offer(sub: Sub, hint: Hint, project: string | null, cursor: string): void {
		const known = project === null ? true : this.memo.peek(sub.actor, project);
		if (sub.queue === null && known !== undefined) {
			this.settle(sub, hint, cursor, known);
			return;
		}
		sub.inflight += 1;
		const previous = sub.queue ?? Promise.resolve();
		sub.queue = previous
			.then(async () => {
				const allowed =
					known ?? (project === null ? true : await this.memo.allowed(sub.actor, project));
				this.settle(sub, hint, cursor, allowed);
			})
			.catch((err) => blog.error("hint delivery failed", { err }))
			.finally(() => {
				sub.inflight -= 1;
				if (sub.inflight === 0) sub.queue = null;
			});
	}

	private settle(sub: Sub, hint: Hint, cursor: string, allowed: boolean): void {
		if (sub.closed) return;
		if (!allowed) {
			this.filtered += 1;
			return;
		}
		this.delivered += 1;
		sub.sink.hint(hint, cursor);
	}

	private index(sub: Sub, keys: readonly string[]): void {
		sub.keys = [...new Set(keys)];
		sub.buckets = distinctBuckets(sub.keys);
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

	private cursorOf(sub: Sub): string {
		return String(this.sumBuckets(sub.buckets));
	}

	private sumBuckets(buckets: readonly number[]): number {
		let sum = 0;
		for (const b of buckets) sum += this.counters[b];
		return sum;
	}
}

/** The distinct counter buckets a set of keys hashes to. */
function distinctBuckets(keys: readonly string[]): number[] {
	return [...new Set(keys.map(bucketOf))];
}

declare global {
	var __alethiaChangeBus: ChangeBus | undefined;
}

/** The process-wide change bus (HMR/instance-safe singleton) over the `alethia_change` transport. */
export function getChangeBus(): ChangeBus {
	globalThis.__alethiaChangeBus ??= new ChangeBus({ transport: getChangeTransport() });
	return globalThis.__alethiaChangeBus;
}
