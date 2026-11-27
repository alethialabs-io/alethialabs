"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { KeysetList } from "@/lib/query/use-keyset-list";
import { useInfiniteScrollSentinel } from "@/lib/query/use-infinite-scroll";

/** The part of a {@link KeysetList} the footer reads. */
export type ListFooterState = Pick<
	KeysetList<unknown>,
	"rows" | "hasMore" | "loadingMore" | "loadMoreFailed" | "loadMore"
>;

/**
 * How far below the viewport the sentinel starts the next page (polish-wave spec §3, #7737): about
 * a screen of rows ahead, so a reader scrolling at reading speed does not meet the spinner.
 */
const AUTO_LOAD_MARGIN = "0px 0px 400px 0px";

/** The media query for a reader who asked the browser to save data. */
const REDUCED_DATA = "(prefers-reduced-data: reduce)";

/** Subscribes to changes of the `prefers-reduced-data` setting; a no-op where it is unsupported. */
function subscribeReducedData(onChange: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const query = window.matchMedia(REDUCED_DATA);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** The current `prefers-reduced-data` answer: false where the browser does not support the query. */
function readReducedData(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(REDUCED_DATA).matches;
}

/** On the server nothing is known about the reader, so the sentinel is armed as usual. */
function readReducedDataOnServer(): boolean {
	return false;
}

/**
 * Whether the reader asked to save data (`prefers-reduced-data`). False where the browser does not
 * support the query, and on the server; follows the setting if it changes while the page is open.
 */
function usePrefersReducedData(): boolean {
	return useSyncExternalStore(subscribeReducedData, readReducedData, readReducedDataOnServer);
}

/**
 * The foot of every keyset list (lib/query/README.md → "Paging"; #7482), lifted from the support
 * cases list (#7395). Four states:
 *
 * - **more to load**: an invisible scroll sentinel that pulls the next page once it is within
 *   ~400px of the viewport, PLUS an always-visible "Load more" button. The button is not a
 *   fallback for old browsers only — it is how a keyboard or screen-reader user, or anyone the
 *   observer never fires for, reaches the next page at all. Under `prefers-reduced-data` the
 *   sentinel stands down and the button is the only way on;
 * - **loading**: the button stays where it was, disabled and `aria-busy`, with a spinner — the
 *   row the reader is looking at does not jump;
 * - **failed**: one line under the rows, "Couldn't load more · Try again". The loaded rows STAY: a
 *   failed later page is not a failed list (the Activity log's E-26 rule);
 * - **the end**: `END OF LIST`, in mono, once there are rows (an empty list is its empty state's
 *   job). Never a count — no "That's all N": a count of what loaded reads as a total, and the
 *   console carries no list counts (README → "Counts"). It is its own `data-slot="list-end"`, so
 *   "the footer has nothing left to do" still reads as no `list-footer`.
 */
export function ListFooter({ list }: { list: ListFooterState }) {
	const { rows, hasMore, loadingMore, loadMoreFailed, loadMore } = list;
	const reducedData = usePrefersReducedData();
	const sentinelRef = useInfiniteScrollSentinel({
		// After a failure the sentinel stands down: re-firing on its own would retry in a loop. The
		// hook itself never observes while a page is in flight (`loading`).
		hasMore: hasMore && !loadMoreFailed && !reducedData,
		loading: loadingMore,
		onLoadMore: loadMore,
		rootMargin: AUTO_LOAD_MARGIN,
		resetKey: rows.length,
	});

	if (loadMoreFailed) {
		return (
			<p
				data-slot="list-footer"
				data-state="failed"
				role="status"
				className="flex items-center justify-center gap-2 pt-1 text-ui-sm text-text-secondary"
			>
				<span>Couldn&apos;t load more</span>
				<span aria-hidden>·</span>
				<Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>
					{loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
					Try again
				</Button>
			</p>
		);
	}

	if (!hasMore) {
		if (rows.length === 0) return null;
		return (
			<p
				data-slot="list-end"
				className="pt-2 pb-1 text-center font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary"
			>
				End of list
			</p>
		);
	}

	return (
		<div data-slot="list-footer" data-state={loadingMore ? "loading" : "more"} className="flex justify-center pt-1">
			{/* Invisible tail sentinel that drives the auto-load-on-scroll. */}
			<div ref={sentinelRef} aria-hidden className="h-px w-px" />
			<Button variant="outline" size="sm" disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={loadMore}>
				{loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
				Load more
			</Button>
		</div>
	);
}
