"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The route hairline (polish-wave spec §2, #7740): 2px of foreground ink at the top of the content
// area. It appears only when a client navigation takes longer than 200ms, eases to about 86%, then
// completes and fades when the new route commits. The sidebar gets no spinner.
//
// HOW A NAVIGATION IS SEEN. The App Router has no "navigation started" hook for components:
// `useLinkStatus` only reports the `<Link>` it is rendered inside, and nothing reports a
// `router.push` from a table row or a form. The one framework signal that covers every App Router
// navigation — link, `router.push`/`replace`, back/forward — is `onRouterTransitionStart` in
// `instrumentation-client.ts` (Next 16, `next/dist/docs/.../instrumentation-client.md`). That file
// calls `signalRouteTransitionStart`, which dispatches a window event this component listens for.
// The END is the route committing: `usePathname()` / `useSearchParams()` change once the new tree
// renders (its `loading.tsx` included), which is the moment the content area has answered.
//
// A navigation that never commits — a click to the URL already shown, a hash change — never
// starts the bar, and one that is abandoned (a redirect back to this URL, a failed fetch) is
// finished after GIVE_UP_MS rather than left parked at 86%.

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** The window event `instrumentation-client.ts` raises at the start of an App Router navigation. */
export const ROUTE_TRANSITION_START = "alethia:route-transition-start";

/** How long a navigation must run before the hairline shows (spec: "longer than 200ms"). */
export const ROUTE_PROGRESS_DELAY_MS = 200;
/** The completion sweep (200ms) plus the fade after it (240ms), as `app/globals.css` runs them. */
const FINISH_MS = 440;
/** A navigation still uncommitted after this long is finished anyway. */
const GIVE_UP_MS = 15_000;

/**
 * Tells the hairline a navigation to `url` has started. Called by `onRouterTransitionStart`; safe
 * on the server (it does nothing there).
 */
export function signalRouteTransitionStart(url: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<string>(ROUTE_TRANSITION_START, { detail: url }));
}

/**
 * Whether a navigation to `url` would change what the content area shows: same origin, and a
 * different path or query than `current`. A hash-only change or a click on the page already shown
 * commits nothing, so it must not start a bar that would then wait for a commit.
 */
export function changesRoute(
	url: string,
	current: Pick<Location, "href" | "origin" | "pathname" | "search">,
): boolean {
	let target: URL;
	try {
		target = new URL(url, current.href);
	} catch {
		return false;
	}
	return (
		target.origin === current.origin &&
		target.pathname + target.search !== current.pathname + current.search
	);
}

/** One navigation the hairline is tracking. */
interface Run {
	/** Distinguishes this run from the one a later navigation replaces it with. */
	id: number;
	/** The route key when it started; the run has committed once the key differs. */
	from: string;
	/** The 200ms have passed and the bar is drawn. */
	visible: boolean;
	/** GIVE_UP_MS passed with no commit. */
	abandoned: boolean;
}

/** What the bar draws: nothing, the run to ~86%, or the completion and fade. */
type Phase = "idle" | "running" | "done";

/**
 * The hairline. Mount it once, at the top of the content area, inside a `<Suspense>` (it reads
 * `useSearchParams`). It is decorative — `aria-hidden` — because the route's own `loading.tsx`
 * or skeleton is what tells assistive technology the region is pending.
 */
export function RouteProgress() {
	const pathname = usePathname();
	const search = useSearchParams()?.toString() ?? "";
	const routeKey = search ? `${pathname}?${search}` : pathname;

	const [run, setRun] = useState<Run | null>(null);
	// The key as of the last commit, for the event handler and the timers, which outlive a render.
	const keyRef = useRef(routeKey);
	useEffect(() => {
		keyRef.current = routeKey;
	}, [routeKey]);

	useEffect(() => {
		let nextId = 0;
		const timers = new Set<ReturnType<typeof setTimeout>>();
		/** Runs `fn` after `ms`, remembering the timer so unmount clears it. */
		const later = (fn: () => void, ms: number) => {
			const t = setTimeout(() => {
				timers.delete(t);
				fn();
			}, ms);
			timers.add(t);
		};
		/** A navigation started: track it, and draw the bar if it is still running in 200ms. */
		const onStart = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
			if (!changesRoute(event.detail, window.location)) return;
			const id = ++nextId;
			const from = keyRef.current;
			// A navigation that replaces one already drawn keeps the bar where it is.
			setRun((prev) => ({
				id,
				from,
				visible: prev !== null && prev.visible && !prev.abandoned && prev.from === from,
				abandoned: false,
			}));
			later(() => {
				if (keyRef.current !== from) return;
				setRun((r) => (r !== null && r.id === id ? { ...r, visible: true } : r));
			}, ROUTE_PROGRESS_DELAY_MS);
			later(() => {
				setRun((r) => (r !== null && r.id === id ? { ...r, abandoned: true } : r));
			}, GIVE_UP_MS);
		};
		window.addEventListener(ROUTE_TRANSITION_START, onStart);
		return () => {
			window.removeEventListener(ROUTE_TRANSITION_START, onStart);
			for (const t of timers) clearTimeout(t);
		};
	}, []);

	const finished = run !== null && (run.from !== routeKey || run.abandoned);

	// Once the run has finished, forget it — after the sweep and fade if the bar was drawn.
	useEffect(() => {
		if (run === null || !finished) return;
		const { id } = run;
		const t = setTimeout(
			() => setRun((r) => (r !== null && r.id === id ? null : r)),
			run.visible ? FINISH_MS : 0,
		);
		return () => clearTimeout(t);
	}, [run, finished]);

	let phase: Phase = "idle";
	if (run !== null && run.visible) phase = finished ? "done" : "running";

	return <div aria-hidden="true" data-slot="route-progress" data-state={phase} className="route-progress" />;
}
