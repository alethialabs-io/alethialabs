// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One change stream per BROWSER per org, not per tab (#6115, ADR 0005 §10 R8). On plain HTTP/1.1 a
// browser opens at most six connections to an origin; one held-open stream per tab hangs every
// request in every tab past ~5 tabs. So the tabs of one org elect a leader, only the leader holds
// the stream, and it relays what it hears to the others over a BroadcastChannel.
//
// Two election mechanisms, because Web Locks exist only in a SECURE context:
// - Web Locks (`navigator.locks`): every tab queues for one lock; the holder leads; when it goes
//   away (closed, crashed, discarded) the browser hands the lock to the next tab in the queue.
// - A BroadcastChannel LEASE for an insecure context (a self-host served over plain HTTP — the very
//   case R8 is about): the leader beats every 2 s; a tab that hears no beat for 3 beats claims after
//   a random 0–500 ms; two leaders that hear each other resolve to the VISIBLE one, then to the
//   lowest tab id. A hidden tab never claims, and a hidden leader yields after a short grace: a
//   browser throttles a hidden tab's timers (to once a minute after a while), and a leader whose beat
//   slows to that would otherwise be presumed gone and re-elected over and over.

/** The slice of `navigator.locks` the election uses. */
export interface LockManagerLike {
	request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

/** The slice of `BroadcastChannel` the election and the relay use. */
export interface ChannelLike {
	postMessage(message: unknown): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	close(): void;
}

/** The lease's beat, and how many missed beats make a leader presumed gone. */
export const LEASE_BEAT_MS = 2000;
export const LEASE_MISSED_BEATS = 3;
/** The random spread before a claim, so tabs that noticed together do not all claim together. */
const LEASE_CLAIM_JITTER_MS = 500;
/** How long a lease leader may stay hidden before it yields to a visible tab. */
const LEASE_HIDDEN_GRACE_MS = 10_000;

/**
 * A random tab id. Built from `crypto.getRandomValues`, which every context has, and NOT from
 * `crypto.randomUUID`, which exists only in a secure context — the lease exists for the insecure one.
 */
function randomTabId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What {@link electLeader} needs. */
export interface LeaderOptions {
	/** The election's name — one per person per org (`alethia-events:<userId>:<tenant>`). */
	name: string;
	/** Called when this tab becomes the leader. `signal` aborts when it stops leading. */
	onLead(signal: AbortSignal): void;
	/** `navigator.locks` in a secure context; null selects the lease. */
	locks: LockManagerLike | null;
	/** Opens a BroadcastChannel; null when the browser has none (then every tab leads alone). */
	openChannel: (name: string) => ChannelLike | null;
	tabId?: string;
	random?: () => number;
	now?: () => number;
	/** Whether this tab is being looked at (the lease prefers a visible leader). */
	isVisible?: () => boolean;
}

/** A running election. */
export interface Election {
	isLeader(): boolean;
	/** Leaves the election; a leader steps down and its successor takes over. */
	stop(): void;
}

/** Narrows a lease message. */
function leaseMessage(data: unknown): { type: "beat" | "release"; tab: string; visible: boolean } | null {
	if (typeof data !== "object" || data === null) return null;
	const type = "type" in data ? data.type : undefined;
	const tab = "tab" in data ? data.tab : undefined;
	const visible = "visible" in data ? data.visible === true : false;
	if ((type !== "beat" && type !== "release") || typeof tab !== "string") return null;
	return { type, tab, visible };
}

/** Whether leader `a` keeps the lease over leader `b`: a visible tab wins, then the lower id. */
function outranks(a: { tab: string; visible: boolean }, b: { tab: string; visible: boolean }): boolean {
	if (a.visible !== b.visible) return a.visible;
	return a.tab < b.tab;
}

/** Elects this tab's org leader with Web Locks when it can, the lease when it cannot. */
export function electLeader(options: LeaderOptions): Election {
	return options.locks ? lockElection(options, options.locks) : leaseElection(options);
}

/** The Web Locks election: hold the lock until stopped; the next queued tab inherits it. */
function lockElection(options: LeaderOptions, locks: LockManagerLike): Election {
	const queue = new AbortController(); // leaves the queue if we never got the lock
	const lead = new AbortController(); // ends our leadership if we did
	let leading = false;
	locks
		.request(options.name, { signal: queue.signal }, () => {
			if (lead.signal.aborted) return Promise.resolve();
			leading = true;
			options.onLead(lead.signal);
			return new Promise<void>((resolve) => {
				lead.signal.addEventListener("abort", () => resolve());
			});
		})
		.catch(() => {
			/* aborted while queued: we left before our turn */
		})
		.finally(() => {
			leading = false;
		});
	return {
		isLeader: () => leading,
		stop() {
			leading = false;
			lead.abort();
			queue.abort();
		},
	};
}

/** The BroadcastChannel lease for insecure contexts. */
function leaseElection(options: LeaderOptions): Election {
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;
	const isVisible = options.isVisible ?? (() => true);
	const me = options.tabId ?? randomTabId();
	const channel = options.openChannel(`${options.name}:lease`);

	let lead: AbortController | null = null;
	let stopped = false;
	// Start as if the last beat was two beats ago: a leader that exists answers within one beat, and
	// a tab alone claims after about one beat rather than three.
	let lastBeatAt = now() - (LEASE_MISSED_BEATS - 1) * LEASE_BEAT_MS;
	let claimTimer: ReturnType<typeof setTimeout> | null = null;
	let hiddenSince: number | null = null;

	const beat = () => channel?.postMessage({ type: "beat", tab: me, visible: isVisible() });

	const becomeLeader = () => {
		if (stopped || lead) return;
		lead = new AbortController();
		beat();
		options.onLead(lead.signal);
	};

	const stepDown = () => {
		if (!lead) return;
		const ending = lead;
		lead = null;
		ending.abort();
	};

	if (!channel) {
		// No BroadcastChannel at all: nothing to coordinate with, so this tab streams for itself.
		becomeLeader();
		return {
			isLeader: () => lead !== null,
			stop() {
				stopped = true;
				stepDown();
			},
		};
	}

	const onMessage = (event: MessageEvent) => {
		const message = leaseMessage(event.data);
		if (!message || message.tab === me) return;
		if (message.type === "release") {
			lastBeatAt = Number.NEGATIVE_INFINITY; // the leader left: claim on the next tick
			return;
		}
		if (lead) {
			// Two leaders hear each other: the visible one keeps it, then the lower tab id.
			if (outranks(message, { tab: me, visible: isVisible() })) {
				stepDown();
				lastBeatAt = now();
			}
			return;
		}
		lastBeatAt = now();
		if (claimTimer !== null) {
			clearTimeout(claimTimer);
			claimTimer = null;
		}
	};
	channel.addEventListener("message", onMessage);

	// The lease's beat. A real timer, not a data poll: it carries no data and fetches nothing.
	const tick = setInterval(() => {
		if (stopped) return;
		if (lead) {
			if (isVisible()) hiddenSince = null;
			else hiddenSince ??= now();
			if (hiddenSince !== null && now() - hiddenSince >= LEASE_HIDDEN_GRACE_MS) {
				// Hidden too long: yield, so a visible tab with unthrottled timers leads instead.
				channel.postMessage({ type: "release", tab: me });
				stepDown();
				hiddenSince = null;
				lastBeatAt = now();
				return;
			}
			beat();
			return;
		}
		if (claimTimer !== null || !isVisible()) return; // a hidden tab never claims
		if (now() - lastBeatAt < LEASE_MISSED_BEATS * LEASE_BEAT_MS) return;
		claimTimer = setTimeout(() => {
			claimTimer = null;
			if (now() - lastBeatAt >= LEASE_MISSED_BEATS * LEASE_BEAT_MS) becomeLeader();
		}, Math.floor(random() * LEASE_CLAIM_JITTER_MS));
	}, LEASE_BEAT_MS);

	return {
		isLeader: () => lead !== null,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(tick);
			if (claimTimer !== null) clearTimeout(claimTimer);
			if (lead) channel.postMessage({ type: "release", tab: me });
			stepDown();
			channel.removeEventListener("message", onMessage);
			channel.close();
		},
	};
}
