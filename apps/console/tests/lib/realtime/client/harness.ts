// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deterministic plumbing for the real-time client's tests (#6115). Nothing here reads a wall clock:
// waiting is counted in event-loop turns, and the cross-tab channel delivers on a microtask, so a test
// gives the same answer on an idle laptop and on a saturated CI runner. Timers are faked by each test.

import type { ChannelLike } from "@/lib/realtime/client/leader";

/** How many event-loop turns {@link until} allows before it calls the condition unreachable. */
const MAX_TURNS = 500;

/** The real `setImmediate`, captured before any test fakes timers (vitest's default fakes it too). */
const realSetImmediate = globalThis.setImmediate;

/** One event-loop turn: every pending microtask, then one macrotask hop (not a timer). */
export function turn(): Promise<void> {
	return new Promise((resolve) => realSetImmediate(() => resolve()));
}

/** Runs `n` event-loop turns. */
export async function settle(n = 20): Promise<void> {
	for (let i = 0; i < n; i++) await turn();
}

/**
 * Waits until `condition` holds, counting event-loop turns rather than milliseconds. Turns do not
 * depend on how loaded the machine is, so this cannot time out on a slow runner and pass on a fast
 * one; when the condition is unreachable it fails with `what`.
 */
export async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < MAX_TURNS; i++) {
		if (condition()) return;
		await turn();
	}
	throw new Error(`never happened within ${MAX_TURNS} event-loop turns: ${what}`);
}

/** A channel the test can silence (a crashed tab sends nothing, not even a release). */
export interface TestChannel extends ChannelLike {
	muted: boolean;
}

/**
 * An in-memory BroadcastChannel: a message reaches every OTHER open channel of the same name, on a
 * microtask, as a structured clone. Same semantics the client relies on; no real I/O.
 */
export function memoryChannels() {
	const open = new Map<string, Set<{ deliver: (data: unknown) => void }>>();
	const opened: TestChannel[] = [];
	const channel = (name: string): TestChannel => {
		const listeners = new Set<(event: MessageEvent) => void>();
		const peers = open.get(name) ?? new Set();
		open.set(name, peers);
		const self = {
			deliver: (data: unknown) => {
				for (const listener of listeners) listener(new MessageEvent("message", { data: structuredClone(data) }));
			},
		};
		peers.add(self);
		let closed = false;
		const result: TestChannel = {
			muted: false,
			postMessage(message) {
				if (closed) throw new DOMException("closed", "InvalidStateError");
				if (result.muted) return;
				for (const peer of peers) if (peer !== self) queueMicrotask(() => peer.deliver(message));
			},
			addEventListener: (_type, listener) => listeners.add(listener),
			removeEventListener: (_type, listener) => listeners.delete(listener),
			close() {
				closed = true;
				peers.delete(self);
				listeners.clear();
			},
		};
		opened.push(result);
		return result;
	};
	return { open: channel, opened };
}
