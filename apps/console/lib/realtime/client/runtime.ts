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
import { type ChannelLike, electLeader, type LockManagerLike } from "./leader";
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
}

/** Starts the org's real-time client; returns the stop function. */
export function startRealtime(options: RealtimeOptions): () => void {
	const store = options.store ?? connectionStore;
	const isVisible = options.isVisible ?? tabVisible;
	const openChannel = options.openChannel ?? browserChannel;
	const name = `alethia-events:${options.tenant}`;
	const url = `/${encodeURIComponent(options.tenant)}/~/events`;

	store.set("connecting");
	const coalescer = createCoalescer({ queryClient: options.queryClient, topicKeys: TOPIC_KEYS, isVisible });
	const relay = openChannel(name);
	let position: StreamPosition | undefined;
	let removedNoted = false;

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
				// A tab that just joined asks the leader where things stand.
				if (election.isLeader()) {
					relay?.postMessage({ type: "state", state: store.get().state });
					if (position) relay?.postMessage({ type: "position", position });
				}
				return;
		}
	};
	relay?.addEventListener("message", onRelay);

	const election = electLeader({
		name,
		locks: options.locks === undefined ? browserLocks() : options.locks,
		openChannel,
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
	relay?.postMessage({ type: "sync" });

	const stopPoll = startFallbackPoll({ store, isVisible, refresh: () => coalescer.refreshAll() });

	return () => {
		stopPoll();
		election.stop();
		coalescer.dispose();
		relay?.removeEventListener("message", onRelay);
		relay?.close();
		if (!isTerminal(store.get().state)) store.set("connecting");
	};
}
