// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// HOW THE DOWNLOAD WAITS FOR THE RUNNER WITHOUT A TIMER LOOP (lib/realtime/README.md, rule 3).
//
// A kubeconfig mint is a job. The runner posts the sealed result while the job is executing and then
// completes the job, and every job transition is a `jobs` hint on the org's change stream, which
// invalidates the `jobs` topic's keys (lib/query/topics.ts) — the legacy `["jobs"]` prefix among
// them. So the wait is a Query entry under that prefix with NO fetcher: reading a mint collects it
// (the read is served once and deletes the row), which is a write, and a write is not a `queryFn`.
// The control keeps the entry mounted, and this module turns "the entry was invalidated" into a
// promise the flow awaits before it reads the mint again. While the stream is down the one
// sanctioned fallback poll invalidates the same keys, so the wait still ends.
//
// NO LOST WAKE-UP. The entry is re-armed (written, which clears its invalidated flag) BEFORE each
// read of the mint, and the wait that follows returns at once when the flag is already set. A hint
// that lands while the read is in flight is therefore answered by one more read, never missed.

import { type QueryClient, type QueryKey, hashKey } from "@tanstack/react-query";

/** The key prefix of every mint wait: under `["jobs"]`, which the `jobs` topic invalidates. */
export const MINT_WAIT_KEY = ["jobs", "kubeconfig-mint"] as const;

/** The wait entry's key for one cluster. */
export function mintWaitKey(clusterId: string): QueryKey {
	return [...MINT_WAIT_KEY, clusterId];
}

/** The wait a download holds while the runner mints. */
export interface MintWait {
	/** Clears the "something changed" mark. Call before each read of the mint. */
	arm(): void;
	/**
	 * Resolves when a job has moved since the last {@link arm}, when `deadline` (epoch ms) passes,
	 * when the tab becomes visible again, or when `signal` aborts — whichever is first.
	 */
	changed(deadline: number, signal: AbortSignal): Promise<void>;
}

/** What {@link createMintWait} needs beyond the client; tests pin the clock and the timer. */
export interface MintWaitOptions {
	now?: () => number;
	timers?: {
		setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
		clearTimeout(handle: ReturnType<typeof setTimeout>): void;
	};
	/** The document whose visibility ends a wait; absent outside a browser. */
	visibility?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

/**
 * Builds the wait over `queryClient` — the org's client, the one its change stream invalidates —
 * for the entry at `key`. The caller keeps that entry mounted for as long as the wait is used.
 */
export function createMintWait(queryClient: QueryClient, key: QueryKey, options: MintWaitOptions = {}): MintWait {
	const now = options.now ?? (() => Date.now());
	const timers = options.timers ?? {
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	};
	const visibility = options.visibility ?? (typeof document === "undefined" ? undefined : document);
	const hash = hashKey(key);
	let armed = 0;

	return {
		arm() {
			armed += 1;
			queryClient.setQueryData(key, armed);
		},
		changed(deadline, signal) {
			return new Promise<void>((resolve) => {
				if (signal.aborted || queryClient.getQueryState(key)?.isInvalidated) {
					resolve();
					return;
				}
				/** Ends the wait once, releasing everything it listened on. */
				const finish = () => {
					unsubscribe();
					timers.clearTimeout(timer);
					signal.removeEventListener("abort", finish);
					visibility?.removeEventListener("visibilitychange", onVisible);
					resolve();
				};
				/** A tab looked at again may have missed a hint while hidden: read once more. */
				const onVisible = () => {
					if (visibility?.visibilityState === "visible") finish();
				};
				const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
					if (event.type !== "updated" || event.action.type !== "invalidate") return;
					if (hashKey(event.query.queryKey) === hash) finish();
				});
				const timer = timers.setTimeout(finish, Math.max(0, deadline - now()));
				signal.addEventListener("abort", finish);
				visibility?.addEventListener("visibilitychange", onVisible);
			});
		},
	};
}
