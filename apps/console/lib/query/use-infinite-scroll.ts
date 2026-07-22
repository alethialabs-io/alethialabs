"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Auto-load-on-scroll sentinel — the "keep scrolling" half of a paginated list. Attach the
// returned ref to a small element at the tail of the list; when it scrolls within `rootMargin`
// of the viewport and there's a further page, `onLoadMore` fires. It complements (never replaces)
// a visible "Load more" button, so a11y / no-JS / keyboard users still have an explicit control.
//
// The observer is only mounted while `hasMore && !loading`, which (a) never re-fires mid-flight and
// (b) fixes the classic "sentinel is still in view after a page loads" stall: when `loading` flips
// back to false the effect re-subscribes, and `observe()` re-delivers the current intersection —
// so an in-view sentinel pulls the next page immediately, without the user having to nudge scroll.

import { useEffect, useRef } from "react";

/** Returns a ref for a tail sentinel element; calls `onLoadMore` when it comes into view and a
 * further page exists. `rootMargin` grows the trigger zone so the fetch starts slightly early.
 * Pass `resetKey` (e.g. the rendered row count) for synchronous pagers that have no `loading`
 * flip: changing it re-subscribes the observer, so an already-in-view sentinel keeps pulling
 * pages until the viewport fills or the list is exhausted. */
export function useInfiniteScrollSentinel<T extends Element = HTMLDivElement>({
	hasMore,
	loading,
	onLoadMore,
	rootMargin = "0px 0px 200px 0px",
	resetKey,
}: {
	hasMore: boolean;
	loading: boolean;
	onLoadMore: () => void;
	rootMargin?: string;
	resetKey?: unknown;
}) {
	const ref = useRef<T | null>(null);
	// Keep the latest callback in a ref so the observer effect below doesn't re-subscribe when the
	// caller passes a fresh `onLoadMore` each render (which would thrash the observer, or worse,
	// re-fire immediately while the sentinel is in view). Synced in an effect, never during render.
	const onLoadMoreRef = useRef(onLoadMore);
	useEffect(() => {
		onLoadMoreRef.current = onLoadMore;
	});

	useEffect(() => {
		const el = ref.current;
		if (el == null || typeof IntersectionObserver === "undefined") return;
		// Don't observe while a page is in flight or the list is exhausted.
		if (!hasMore || loading) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					onLoadMoreRef.current();
				}
			},
			{ rootMargin },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, loading, rootMargin, resetKey]);

	return ref;
}
