// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// THE ONLY PLACE IN THE CONSOLE THAT READS THE LIVE CLIENT SESSION (#5382), through `liveSession`
// (lib/auth/client.ts). better-auth's own `authClient.useSession()` is refused by eslint everywhere
// — see the `useSession` block in apps/console/eslint.config.mjs.
//
// Why: better-auth's React binding (`useStore`) calls `useSyncExternalStore(subscribe, get, get)`,
// so the LIVE client session is also handed over as the SERVER snapshot. A component that renders
// from it therefore hydrates against whatever the browser's session fetch holds at that instant,
// not against what the server rendered. When the fetch resolves before the component hydrates, the
// markup differs and React throws #418 — intermittently, because it is a race (#5377, #5380).
//
// `useViewer()` closes that race: until this component has hydrated it returns the value the
// SERVER rendered with — the session the private layout read for this request, passed down through
// `ViewerProvider`. And while that seed is current it does not subscribe to the live session at all,
// because subscribing is what makes better-auth fetch `/get-session` (#6114) — see `useViewer`.

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type React from "react";
import { type LiveSessionRead, liveSession } from "@/lib/auth/client";
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

/** The live session's answer while it is not being followed — the same as before its first fetch. */
const NOT_FOLLOWED: LiveSessionRead = { data: null, isPending: true, error: null, settled: false };

/** Unsubscribing from nothing. */
function noop(): void {}

/**
 * Whether the session may have changed since this page loaded (module-wide): a client auth call,
 * another tab's session change, or the tab returning to view — see `liveSession.onPossibleChange`.
 */
let sessionChanged = false;
const changeListeners = new Set<() => void>();
let detachChange: (() => void) | null = null;

/** Subscribes to "the session may have changed"; attaches on first use. */
function subscribeSessionChanged(listener: () => void): () => void {
	changeListeners.add(listener);
	detachChange ??= liveSession.onPossibleChange(() => {
		sessionChanged = true;
		for (const notify of changeListeners) notify();
	});
	return () => {
		changeListeners.delete(listener);
	};
}

/** The current answer to "may the session have changed". */
function getSessionChanged(): boolean {
	return sessionChanged;
}

/**
 * The hydration-safe signed-in person.
 *
 * SEEDED (every private route — the layout read the session for this request): renders the seed,
 * and asks the browser for nothing (#6114). It used to subscribe to the live better-auth session
 * on every page, and a subscription is what makes better-auth fetch `/get-session` — a request
 * on each load for an answer the server had just sent. It starts following the live session as
 * soon as the session MAY have changed: a client auth call in this tab, a session change in
 * another tab, or this tab coming back into view (`liveSession.onPossibleChange`). Once following
 * it stays following. Until the live session first answers it keeps showing the seed, so the UI
 * does not blink to "signed out"; after that the last live answer is the viewer, through any later
 * failed refetch. A live answer with no session, or a 401, is signed out.
 *
 * UNSEEDED (no `ViewerProvider` above: a public route, a test): follows the live session, and the
 * pre-hydration answer is `{ viewer: null, isPending: true }` on both sides, which is equally
 * hydration-safe: it just renders the loading state first.
 */
export function useViewer(): ViewerState {
	const seed = useContext(ViewerSeedContext);
	const changed = useSyncExternalStore(subscribeSessionChanged, getSessionChanged, () => false);
	const follow = seed === null || changed;
	const subscribe = useCallback(
		(listener: () => void) => (follow ? liveSession.subscribe(listener) : noop),
		[follow],
	);
	const live = useSyncExternalStore(
		subscribe,
		() => (follow ? liveSession.get() : NOT_FOLLOWED),
		() => NOT_FOLLOWED,
	);
	const hydrated = useHydrated();
	// Memoised on the session's own user object, which better-auth keeps stable between session
	// ticks: a fresh `Viewer` every render would re-fire every effect keyed on it.
	const liveUser = live.data?.user;
	const liveViewer = useMemo(() => (liveUser ? toViewer(liveUser) : null), [liveUser]);

	// A 401 is an answer — signed out — not a failed fetch to ride out on the seed.
	const unauthorized =
		typeof live.error === "object" &&
		live.error !== null &&
		"status" in live.error &&
		live.error.status === 401;
	if (hydrated && unauthorized) return { viewer: null, isPending: false };
	if (!hydrated) {
		if (seed) return { viewer: seed.viewer, isPending: false };
		return { viewer: null, isPending: true };
	}
	// Once the live session has answered, its last answer IS the viewer — a later failed or
	// in-flight fetch (a 5xx, a dropped connection) keeps it, including a settled "nobody". The seed
	// is only the answer BEFORE the first live answer; falling back to it later would show an
	// identity the live session has already moved away from.
	if (live.settled) return { viewer: liveViewer, isPending: false };
	if (seed) return { viewer: seed.viewer, isPending: false };
	if (live.isPending || live.error != null) return { viewer: null, isPending: live.isPending };
	return { viewer: liveViewer, isPending: false };
}
