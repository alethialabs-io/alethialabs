"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Loader2 } from "lucide-react";
import type { KeysetList } from "@/lib/query/use-keyset-list";
import { useInfiniteScrollSentinel } from "@/lib/query/use-infinite-scroll";

/** The part of a {@link KeysetList} the footer reads. */
export type ListFooterState = Pick<
	KeysetList<unknown>,
	"rows" | "hasMore" | "loadingMore" | "loadMoreFailed" | "loadMore"
>;

/**
 * The foot of every keyset list (lib/query/README.md → "Paging"; #7482), lifted from the support
 * cases list (#7395). Four states, and the fourth is deliberately nothing:
 *
 * - **more to load**: an invisible scroll sentinel that pulls the next page as the reader nears the
 *   end, PLUS an always-visible "Load more" button. The button is not a fallback for old browsers
 *   only — it is how a keyboard or screen-reader user, or anyone the observer never fires for,
 *   reaches the next page at all;
 * - **loading**: the button stays where it was, disabled and `aria-busy`, with a spinner — the
 *   row the reader is looking at does not jump;
 * - **failed**: one line under the rows, "Couldn't load more · Try again". The loaded rows STAY: a
 *   failed later page is not a failed list (the Activity log's E-26 rule);
 * - **the end**: nothing. No "That's all N" — a count of what loaded reads as a total, and the
 *   console carries no list counts (README → "Counts").
 */
export function ListFooter({ list }: { list: ListFooterState }) {
	const { rows, hasMore, loadingMore, loadMoreFailed, loadMore } = list;
	const sentinelRef = useInfiniteScrollSentinel({
		// After a failure the sentinel stands down: re-firing on its own would retry in a loop.
		hasMore: hasMore && !loadMoreFailed,
		loading: loadingMore,
		onLoadMore: loadMore,
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

	if (!hasMore) return null;

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
