// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// THE ONLY PLACE IN THE CONSOLE THAT READS `authClient.useSession()` (#5382). eslint refuses it
// anywhere else in product code — see the `useSession` block in apps/console/eslint.config.mjs.
//
// Why: better-auth's React binding (`useStore`) calls `useSyncExternalStore(subscribe, get, get)`,
// so the LIVE client session is also handed over as the SERVER snapshot. A component that renders
// from it therefore hydrates against whatever the browser's session fetch holds at that instant,
// not against what the server rendered. When the fetch resolves before the component hydrates, the
// markup differs and React throws #418 — intermittently, because it is a race (#5377, #5380).
//
// `useViewer()` closes that race: until this component has hydrated it returns the value the
// SERVER rendered with — the session the private layout read for this request, passed down through
// `ViewerProvider` — and only after hydration does it follow the live session.

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type React from "react";
import { authClient } from "@/lib/auth/client";
import { toViewer, type Viewer } from "@/lib/auth/viewer";

/**
 * The server's answer for this request. The wrapper object distinguishes "the server read the
 * session and there is nobody signed in" (`{ viewer: null }`) from "nothing was seeded"
 * (no provider at all, the context default `null`).
 */
interface ViewerSeed {
	viewer: Viewer | null;
}

const ViewerSeedContext = createContext<ViewerSeed | null>(null);

/**
 * Seeds `useViewer()` with the session the server rendered this request with. Mounted by the
 * private layout; `viewer` is what `getViewer()` read there.
 */
export function ViewerProvider({
	viewer,
	children,
}: {
	viewer: Viewer | null;
	children: React.ReactNode;
}) {
	return (
		<ViewerSeedContext.Provider value={{ viewer }}>
			{children}
		</ViewerSeedContext.Provider>
	);
}

/** What `useViewer()` answers: the signed-in person, and whether that is still unknown. */
export interface ViewerState {
	/** The signed-in person, or `null` when nobody is (or it is not known yet — see `isPending`). */
	viewer: Viewer | null;
	/** True only when there is no server seed AND the live session has not resolved yet. */
	isPending: boolean;
}

/** No-op subscription: the hydration flag below never changes after it first flips. */
function subscribeNever(): () => void {
	return () => {};
}

/** True once this component has hydrated (or was mounted on the client without hydrating). */
function useHydrated(): boolean {
	// `getServerSnapshot` is what React uses on the server AND during hydration, so this reads
	// `false` in both, then `true` on the re-render React schedules right after hydration. A
	// component mounted later on the client (a sheet opened, a client navigation) reads `true` at once.
	return useSyncExternalStore(
		subscribeNever,
		() => true,
		() => false,
	);
}

/**
 * The hydration-safe signed-in person. Renders with the server's seed until the component has
 * hydrated, then follows the live better-auth session — falling back to the seed while that
 * session is still loading or its fetch failed, so the UI does not blink to "signed out".
 *
 * With no `ViewerProvider` above (a public route, a test), the pre-hydration answer is
 * `{ viewer: null, isPending: true }` on both sides, which is equally hydration-safe: it just
 * renders the loading state first.
 */
export function useViewer(): ViewerState {
	const seed = useContext(ViewerSeedContext);
	const live = authClient.useSession();
	const hydrated = useHydrated();
	// Memoised on the session's own user object, which better-auth keeps stable between session
	// ticks: a fresh `Viewer` every render would re-fire every effect keyed on it.
	const liveUser = live.data?.user;
	const liveViewer = useMemo(() => (liveUser ? toViewer(liveUser) : null), [liveUser]);

	const liveUnsettled = live.isPending || live.error != null;
	if (!hydrated || liveUnsettled) {
		if (seed) return { viewer: seed.viewer, isPending: false };
		return { viewer: null, isPending: !hydrated || live.isPending };
	}
	return { viewer: liveViewer, isPending: false };
}
