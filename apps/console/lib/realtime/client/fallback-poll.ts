// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ONE SANCTIONED POLL (#6115, ADR 0005 §10 R7). "Live by default" deleted the console's data
// polls; this is what keeps a page from going silently stale when the stream it relies on is down.
// It runs only while the stream is NOT live — after 15 s of that, every 30 s, and only in a tab
// someone is looking at — and stops the moment the stream says hello again (whose reconnect resync
// then refreshes everything once). `pnpm check:no-polling` allows this file's interval and no other
// poll under lib/realtime/.

import { type ConnectionStore, isTerminal } from "./connection-state";

/** How long the stream must be down before polling starts, and the poll's period. */
const FALLBACK_GRACE_MS = 15_000;
const FALLBACK_PERIOD_MS = 30_000;

/** What {@link startFallbackPoll} needs. */
export interface FallbackPollOptions {
	store: ConnectionStore;
	isVisible: () => boolean;
	/** Refetch what is on screen for every live topic (the coalescer's `refreshAll`). */
	refresh: () => void;
}

/** Starts watching the connection; returns the stop function. */
export function startFallbackPoll(options: FallbackPollOptions): () => void {
	let grace: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;

	const halt = () => {
		if (grace !== null) clearTimeout(grace);
		if (poll !== null) clearInterval(poll);
		grace = null;
		poll = null;
	};

	const react = () => {
		const { state } = options.store.get();
		// Live: nothing to make up for. Terminal: a poll would only be refused (signed out) or would
		// read an address that is no longer ours (removed) — the page is refreshed instead.
		if (state === "live" || isTerminal(state)) {
			halt();
			return;
		}
		if (grace !== null || poll !== null) return; // already counting down or polling
		const tick = () => {
			if (options.isVisible()) options.refresh();
		};
		grace = setTimeout(() => {
			grace = null;
			tick(); // the first refresh at the end of the grace, then one per period
			poll = setInterval(tick, FALLBACK_PERIOD_MS);
		}, FALLBACK_GRACE_MS);
	};

	const unsubscribe = options.store.subscribe(react);
	react();
	return () => {
		unsubscribe();
		halt();
	};
}
