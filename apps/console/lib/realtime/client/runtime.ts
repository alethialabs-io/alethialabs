// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Wires one org's real-time client together (#6115, ADR 0005 D3): the leader election, the stream
// the leader holds, the relay to the other tabs, each tab's own coalescer, the connection state and
// the fallback poll. `components/shell/realtime-mount.tsx` starts one per org address and stops it
// when the address changes org.

import type { QueryClient } from "@tanstack/react-query";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { type Hint, isTopic } from "@/lib/realtime/topics";
import { createCoalescer } from "./coalescer";
import {
	type ConnectionState,
	type ConnectionStore,
	connectionStore,
	isTerminal,
} from "./connection-state";
import { startFallbackPoll } from "./fallback-poll";
import {
	type ChannelLike,
	type Election,
	type ElectionRegistry,
	electLeader,
	type LockManagerLike,
	newElectionRegistry,
	pageElectionRegistry,
} from "./leader";
import { runStream, type StreamPosition } from "./stream";

/** What the leader tab tells the others. */
type RelayMessage =
	| { type: "hint"; hint: Hint }
	| { type: "resync" }
	| { type: "state"; state: ConnectionState }
	| { type: "position"; position: StreamPosition }
	| { type: "sync" };

const STATES: readonly ConnectionState[] = [
	"connecting",
	"live",
	"reconnecting",
	"degraded",
	"signed-out",
	"removed",
];

/** Narrows a relay message from another tab; anything else is ignored. */
export function readRelayMessage(data: unknown): RelayMessage | null {
	if (typeof data !== "object" || data === null || !("type" in data)) return null;
	switch (data.type) {
		case "resync":
			return { type: "resync" };
		case "sync":
			return { type: "sync" };
		case "state": {
			const state = "state" in data ? STATES.find((s) => s === data.state) : undefined;
			return state ? { type: "state", state } : null;
		}
		case "hint": {
			const hint = "hint" in data ? data.hint : undefined;
			if (typeof hint !== "object" || hint === null || !("t" in hint)) return null;
			const t = hint.t;
			const id = "id" in hint ? hint.id : undefined;
			if (typeof t !== "string" || !isTopic(t)) return null;
			if (id !== undefined && typeof id !== "string") return null;
			return { type: "hint", hint: id === undefined ? { t } : { t, id } };
		}
		case "position": {
			const position = "position" in data ? data.position : undefined;
			if (typeof position !== "object" || position === null) return null;
			const boot = "boot" in position ? position.boot : undefined;
			const cursor = "cursor" in position ? position.cursor : undefined;
			if (typeof boot !== "string" || typeof cursor !== "string") return null;
			return { type: "position", position: { boot, cursor } };
		}
		default:
			return null;
	}
}

/** The browser's election primitives, or the fallbacks when they are missing. */
function browserLocks(): LockManagerLike | null {
	if (typeof window === "undefined" || !window.isSecureContext) return null;
	return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

/** Opens a BroadcastChannel, or null where there is none. */
function browserChannel(name: string): ChannelLike | null {
	return typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
}

/** Whether this tab is being looked at. */
function tabVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/** What {@link startRealtime} needs. */
export interface RealtimeOptions {
	/** The signed-in person: the election and the relay are theirs alone, never shared with
	 * another account signed in to the same browser. */
	userId: string;
	/** The org segment of the address (`acme`, or `~` for the personal scope). */
	tenant: string;
	/** That org's QueryClient, captured once: a late hint for org A must never reach org B's cache. */
	queryClient: Pick<QueryClient, "invalidateQueries">;
	/** Called once when this address is no longer ours (the page should re-ask the server). */
	onRemoved: () => void;
	store?: ConnectionStore;
	locks?: LockManagerLike | null;
	openChannel?: (name: string) => ChannelLike | null;
	fetch?: typeof fetch;
	isVisible?: () => boolean;
	/** Where `pageshow` fires (the window); a bfcache restore rejoins the election and resyncs. */
	pageEvents?: EventTarget | null;
	/** This document's scope (default: this page's). */
	scope?: DocumentScope;
	/** The coalescer's jitter source (tests pin it). */
	random?: () => number;
}

/** The name of one person's election and relay for one org. */
export function electionName(userId: string, tenant: string): string {
	return `alethia-events:${encodeURIComponent(userId)}:${tenant}`;
}

/** Whether a `pageshow` event is a restore from the back/forward cache. */
function restoredFromCache(event: Event): boolean {
	return "persisted" in event && event.persisted === true;
}

/** One document's state: its running runtimes and its elections, by name. Starting a runtime stops
 * any previous one under the same name first, so a remount whose stop was lost cannot leave a second
 * relay listener (duplicate invalidations) or a second election request behind. */
export interface DocumentScope {
	runtimes: Map<string, () => void>;
	elections: ElectionRegistry;
}

/** A fresh document scope — for tests that model several tabs in one process. */
export function newDocumentScope(): DocumentScope {
	return { runtimes: new Map(), elections: newElectionRegistry() };
}

/**
 * This page's scope, on `globalThis` under registered symbols: a bundler can instantiate this module
 * more than once in one document (seen live under the dev server), and every copy must share it.
 */
function pageScope(): DocumentScope {
	const key = Symbol.for("alethia.realtime.runtimes");
	const existing: unknown = Reflect.get(globalThis, key);
	let runtimes: Map<string, () => void>;
	if (existing instanceof Map) {
		runtimes = existing;
	} else {
		runtimes = new Map();
		Reflect.set(globalThis, key, runtimes);
	}
	return { runtimes, elections: pageElectionRegistry() };
}

/** Says, in development only, that a start replaced one still running — the next live check can see it. */
function noteSuperseded(name: string): void {
	if (process.env.NODE_ENV !== "development") return;
	console.debug(`[realtime] a second start for ${name} replaced one still running in this document`, new Error("started here").stack);
}

/**
 * Starts the org's real-time client; returns the stop function (idempotent). It never throws: if any part of it
 * cannot start (a browser without a primitive it expects, a channel that will not open), what was
 * opened is closed again and the tab falls back to the sanctioned poll with the indicator showing.
 */
export function startRealtime(options: RealtimeOptions): () => void {
	const store = options.store ?? connectionStore;
	const isVisible = options.isVisible ?? tabVisible;
	const openChannel = options.openChannel ?? browserChannel;
	const pageEvents =
		options.pageEvents === undefined ? (typeof window === "undefined" ? null : window) : options.pageEvents;
	const name = electionName(options.userId, options.tenant);
	const url = `/${encodeURIComponent(options.tenant)}/~/events`;
	const scope = options.scope ?? pageScope();
	const previous = scope.runtimes.get(name);
	if (previous) {
		noteSuperseded(name);
		previous();
	}

	store.reset(); // a new runtime starts from a first connect: a previous `removed` does not carry over
	const coalescer = createCoalescer({
		queryClient: options.queryClient,
		topicKeys: TOPIC_KEYS,
		isVisible,
		random: options.random,
	});
	const stopPoll = startFallbackPoll({ store, isVisible, refresh: () => coalescer.refreshAll() });

	// Everything opened below registers its undo here, so every exit path closes all of it.
	const undo: Array<() => void> = [];
	const teardown = () => {
		for (const step of undo.splice(0).reverse()) {
			try {
				step();
			} catch {
				/* closing is best effort */
			}
		}
	};

	try {
		const relay = openChannel(name);
		if (relay) undo.push(() => relay.close());
		let position: StreamPosition | undefined;
		let removedNoted = false;
		let election: Election | null = null;

		const applyState = (state: ConnectionState) => {
			store.set(state);
			if (state === "removed" && !removedNoted) {
				removedNoted = true;
				options.onRemoved();
			}
		};

		const onRelay = (event: MessageEvent) => {
			const message = readRelayMessage(event.data);
			if (!message) return;
			switch (message.type) {
				case "hint":
					coalescer.hint(message.hint);
					return;
				case "resync":
					coalescer.resync();
					return;
				case "state":
					applyState(message.state);
					return;
				case "position":
					position = message.position;
					return;
				case "sync":
					// A tab that just joined asks the leader where things stand. Only a LEADER answers,
					// and a leader that reached a terminal state has already left the election.
					if (election?.isLeader()) {
						relay?.postMessage({ type: "state", state: store.get().state });
						if (position) relay?.postMessage({ type: "position", position });
					}
					return;
			}
		};
		if (relay) {
			relay.addEventListener("message", onRelay);
			undo.push(() => relay.removeEventListener("message", onRelay));
		}

		const join = (): Election =>
			electLeader({
				name,
				locks: options.locks === undefined ? browserLocks() : options.locks,
				openChannel,
				isVisible,
				registry: scope.elections,
				onLead(signal) {
					void runStream({
						url,
						signal,
						initial: position,
						fetch: options.fetch,
						onState(state) {
							if (signal.aborted) return;
							applyState(state);
							relay?.postMessage({ type: "state", state });
							// Terminal: nothing this tab can do brings the stream back, so it gives up
							// leadership. A tab opened later (a fresh sign-in, say) must be able to lead.
							if (isTerminal(state)) election?.stop();
						},
						onHint(hint) {
							coalescer.hint(hint);
							relay?.postMessage({ type: "hint", hint });
						},
						onResync() {
							coalescer.resync();
							relay?.postMessage({ type: "resync" });
						},
						onPosition(next) {
							position = next;
							relay?.postMessage({ type: "position", position: next });
						},
					});
				},
			});
		election = join();
		undo.push(() => election?.stop());
		relay?.postMessage({ type: "sync" });

		// A page restored from the back/forward cache missed everything relayed while it was frozen,
		// and its place in the election may be stale: rejoin, ask where things stand, and resync.
		if (pageEvents) {
			const onPageShow = (event: Event) => {
				if (!restoredFromCache(event)) return;
				election?.stop();
				store.reset();
				election = join();
				relay?.postMessage({ type: "sync" });
				coalescer.resync();
			};
			pageEvents.addEventListener("pageshow", onPageShow);
			undo.push(() => pageEvents.removeEventListener("pageshow", onPageShow));
		}
	} catch {
		// Never into the shell's error boundary: degrade to the fallback poll, with the indicator up.
		teardown();
		store.set("degraded");
	}

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		stopPoll();
		teardown();
		coalescer.dispose();
		if (scope.runtimes.get(name) === stop) scope.runtimes.delete(name);
	};
	scope.runtimes.set(name, stop);
	return stop;
}
