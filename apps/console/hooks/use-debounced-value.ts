// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";

/** Options for {@link useDebouncedValue}. */
export interface DebounceOptions {
	/**
	 * What `useFilterUrlSync` returned, for a filter search a pasted LINK can set. From the render
	 * it turns `true` the value lands AT ONCE; only what is typed afterwards waits out the debounce.
	 *
	 * `useFilterUrlSync` patches the store in its mount effect, so a plain debounce starts from the
	 * store's default `""` and catches up `delay` ms later. For `?search=foo&versions=1.4.0` the
	 * client key then went `{}` → `{versions}` → `{search, versions}`, and the middle key — which
	 * the route did not prefetch — cost a real server read and an unfiltered flash (#4980 review).
	 * With it, the first key after the URL is read is the one the route prefetched.
	 */
	urlRead?: boolean;
}

/**
 * Debounce a rapidly-changing value (a search input) before it drives a query.
 * Extracted from the roles/sso/classification managers, which each carried an
 * identical local copy — the console filter standard's debounce step.
 */
export function useDebouncedValue<T>(value: T, delay = 250, options: DebounceOptions = {}): T {
	const [debounced, setDebounced] = useState(value);
	const [seeded, setSeeded] = useState(false);
	// Adjusted DURING render (React's "storing information from previous renders"): React re-runs
	// the component before committing, so the first committed render that sees `urlRead` already
	// holds the URL's value. An effect would commit one render with the stale key first — which is
	// the defect `urlRead` exists for.
	const landNow = options.urlRead === true && !seeded;
	if (landNow) {
		setSeeded(true);
		setDebounced(value);
	}
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(t);
	}, [value, delay]);
	return landNow ? value : debounced;
}
