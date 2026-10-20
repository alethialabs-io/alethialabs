// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Turns change hints into cache invalidations, with herd control (#6115, ADR 0005 D3 + §10 R9).
//
// - COALESCE: a hint opens a window per topic; every further hint on that topic inside the window
//   rides along, so a burst of 50 job updates is one invalidation, not 50 (`invalidateQueries`
//   cancels an in-flight refetch by default, so an uncoalesced burst would thrash).
// - JITTER: the window is 300 ms plus a random 0–750 ms, and a resync waits a random 0–3 s, so a
//   change seen by every tab in an org — or a deploy that resyncs every tab — is spread out.
// - HIDDEN TABS: a tab nobody is looking at marks the queries stale (`refetchType: 'none'`) and
//   refetches nothing; `refetchOnWindowFocus` refetches them when the tab is looked at again.

import type { InvalidateQueryFilters, QueryClient, QueryKey } from "@tanstack/react-query";
import type { Hint, Topic } from "@/lib/realtime/topics";

/** The window a topic's first hint opens: 300 ms + up to 750 ms. */
export const HINT_WINDOW_MS = 300;
export const HINT_JITTER_MS = 750;
/** A resync's spread: up to 3 s. */
export const RESYNC_JITTER_MS = 3000;

/** The one method of a QueryClient the coalescer calls. */
type Invalidator = Pick<QueryClient, "invalidateQueries">;

/** Timer functions, injectable for tests. */
interface Timers {
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const browserTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

/** What {@link createCoalescer} needs. */
export interface CoalescerOptions {
	/** The QueryClient of the org this stream belongs to — captured when the stream started. */
	queryClient: Invalidator;
	/** The query keys each topic invalidates (`TOPIC_KEYS`). */
	topicKeys: Readonly<Record<Topic, () => QueryKey[]>>;
	/** Whether the tab is being looked at right now (read at flush time, not at hint time). */
	isVisible: () => boolean;
	random?: () => number;
	timers?: Timers;
}

/** The coalescer's surface. */
export interface Coalescer {
	/** One hint from the stream. */
	hint(hint: Hint): void;
	/** Invalidate everything this org's client shows, after a jittered delay. */
	resync(): void;
	/** Invalidate every topic's keys NOW and refetch what is on screen (the fallback poll's tick). */
	refreshAll(): void;
	/** Cancels anything scheduled. */
	dispose(): void;
}

/** Builds a coalescer over one org's QueryClient. */
export function createCoalescer(options: CoalescerOptions): Coalescer {
	const random = options.random ?? Math.random;
	const timers = options.timers ?? browserTimers;
	const pending = new Map<Topic, ReturnType<typeof setTimeout>>();
	let resyncTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const refetchType = (): InvalidateQueryFilters["refetchType"] => (options.isVisible() ? "active" : "none");

	const flushTopic = (topic: Topic) => {
		pending.delete(topic);
		if (disposed) return;
		const type = refetchType();
		for (const queryKey of options.topicKeys[topic]()) {
			void options.queryClient.invalidateQueries({ queryKey, refetchType: type });
		}
	};

	const flushAll = () => {
		resyncTimer = null;
		if (disposed) return;
		void options.queryClient.invalidateQueries({ refetchType: refetchType() });
	};

	return {
		hint(hint) {
			if (disposed || resyncTimer !== null || pending.has(hint.t)) return; // already covered
			const delay = HINT_WINDOW_MS + Math.floor(random() * HINT_JITTER_MS);
			pending.set(hint.t, timers.setTimeout(() => flushTopic(hint.t), delay));
		},
		resync() {
			if (disposed || resyncTimer !== null) return;
			// A resync covers every topic, so the topic windows it supersedes are dropped.
			for (const timer of pending.values()) timers.clearTimeout(timer);
			pending.clear();
			resyncTimer = timers.setTimeout(flushAll, Math.floor(random() * RESYNC_JITTER_MS));
		},
		refreshAll() {
			if (disposed) return;
			for (const keys of Object.values(options.topicKeys)) {
				for (const queryKey of keys()) {
					void options.queryClient.invalidateQueries({ queryKey, refetchType: "active" });
				}
			}
		},
		dispose() {
			disposed = true;
			for (const timer of pending.values()) timers.clearTimeout(timer);
			pending.clear();
			if (resyncTimer !== null) timers.clearTimeout(resyncTimer);
			resyncTimer = null;
		},
	};
}
