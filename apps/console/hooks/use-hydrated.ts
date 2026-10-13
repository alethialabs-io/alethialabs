// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useSyncExternalStore } from "react";

/** Nothing ever changes after mount, so there is nothing to subscribe to. */
function subscribeNever(): () => void {
	return () => {};
}

/** In the browser, past hydration. */
function getClientSnapshot(): boolean {
	return true;
}

/** On the server, and during the render that hydrates the server's HTML. */
function getServerSnapshot(): boolean {
	return false;
}

/**
 * `false` for the server render AND for the client render that hydrates it; `true` on every render
 * after that, and from the first render of anything mounted on the client (a soft navigation).
 *
 * WHY A PAGE NEEDS THIS FOR A SHARED QUERY (#5786). The shell — sidebar, topbar, bell — hydrates
 * first, and its `useQuery` hooks start fetching in their mount effects. A page streams into a
 * Suspense boundary that React hydrates in a LATER pass, and if one of the shell's fetches lands
 * in between, a page component reading the same query key renders the data during hydration
 * while the server had rendered it pending. React reports that as #418 and throws the page's
 * server HTML away. Rendering the pending state while this is `false` makes the server render
 * and the hydrating render agree whatever the cache holds by then; React re-renders with `true`
 * straight after, so the data shows a commit later.
 *
 * `useSyncExternalStore` is what makes this exact: React reads `getServerSnapshot` for the server
 * render and for hydration, and `getSnapshot` everywhere else — no effect, so a client mount does
 * not flash the pending state for a frame.
 */
export function useHydrated(): boolean {
	return useSyncExternalStore(subscribeNever, getClientSnapshot, getServerSnapshot);
}
