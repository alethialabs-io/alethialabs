// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { INLINE_PX, INLINE_STROKE, MarkGlyph } from "@repo/ui/spinner";
import { THINKING_VERBS } from "./thinking-verbs";

/**
 * The inline `[·]` mark beside a rotating progressive verb, for an agent that is thinking (#7870,
 * epic #7869): "Combobulating…", "Bringing into focus…", "Triangulating…".
 *
 * ## What a screen reader hears
 *
 * "Thinking", once. The `role="status"` region holds only the label, which never changes while the
 * indicator is mounted, so a polite live region announces it when it appears and then stays quiet.
 * The rotating verb is `aria-hidden` and sits OUTSIDE that region: a verb every 2.5 seconds read
 * aloud would drown out everything else on the page.
 *
 * ## Hydration
 *
 * The server cannot know the visitor's motion preference or pick the client's random verb, so the
 * server render and the hydrating render both show `INITIAL_VERB` with motion assumed allowed.
 * `useReducedMotion` reads `matchMedia` through `useSyncExternalStore`, whose server snapshot is
 * `false`; the random start and the rotation begin in an effect, after hydration.
 *
 * ## Reduced motion
 *
 * The verb is fixed — one random pick, no timer — and the mark is static. The mark's stillness is
 * the `prefers-reduced-motion` block beside `.ah-loader__*` in `../tokens.css`, the same signal this
 * component reads; `data-motion="reduced"` is set on the wrapper for anything that wants to style it.
 */

/** How long each verb shows, in ms. */
export const VERB_INTERVAL_MS = 2500;

/** How many of the most recent verbs the next pick may not repeat. */
export const NO_REPEAT_WINDOW = 20;

/** The verb in the server render and the render that hydrates it, before the random start. */
export const INITIAL_VERB = "Thinking…";

/** The media query whose match means the visitor asked for less motion. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Picks the next verb uniformly from `verbs` minus `recent`. The window is clamped to leave at
 * least one candidate, so a short list still rotates instead of throwing.
 */
export function pickNextVerb(
	verbs: readonly string[],
	recent: readonly string[],
	random: () => number,
	window: number = NO_REPEAT_WINDOW,
): string {
	const span = Math.max(0, Math.min(window, verbs.length - 1));
	const blocked = new Set(span === 0 ? [] : recent.slice(-span));
	const candidates = verbs.filter((verb) => !blocked.has(verb));
	const pool = candidates.length > 0 ? candidates : verbs;
	const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
	return pool[index] ?? INITIAL_VERB;
}

/** What the rotation needs from its surroundings — injected so tests drive it on fake timers. */
export interface VerbRotationHost<Handle> {
	/** A number in [0, 1). */
	random: () => number;
	/** Schedules `fn` after `ms`. */
	setTimer: (fn: () => void, ms: number) => Handle;
	/** Cancels a scheduled `fn`. */
	clearTimer: (handle: Handle) => void;
	/** Whether the visitor asked for reduced motion. */
	reducedMotion: boolean;
	/** Called with each verb to show, the first one synchronously. */
	onVerb: (verb: string) => void;
}

/**
 * Starts the rotation: a random first verb straight away, then a new one every
 * `VERB_INTERVAL_MS`, never one of the last `NO_REPEAT_WINDOW`. Under reduced motion only the first
 * pick happens and no timer is scheduled. Returns the function that stops it.
 */
export function startVerbRotation<Handle>(
	host: VerbRotationHost<Handle>,
	verbs: readonly string[] = THINKING_VERBS,
): () => void {
	const recent: string[] = [];
	let handle: Handle | undefined;
	let stopped = false;
	/** Picks, records and shows one verb. */
	const show = () => {
		const verb = pickNextVerb(verbs, recent, host.random);
		recent.push(verb);
		if (recent.length > NO_REPEAT_WINDOW) recent.shift();
		host.onVerb(verb);
	};
	/** Shows a verb and schedules the next tick. */
	const tick = () => {
		if (stopped) return;
		show();
		handle = host.setTimer(tick, VERB_INTERVAL_MS);
	};
	if (host.reducedMotion) show();
	else tick();
	return () => {
		stopped = true;
		if (handle !== undefined) host.clearTimer(handle);
	};
}

/** Subscribes to changes of the reduced-motion media query. */
function subscribeReducedMotion(onChange: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const query = window.matchMedia(REDUCED_MOTION_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** The browser's current answer to the reduced-motion query. */
function getReducedMotionSnapshot(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The server's answer, and the hydrating render's: motion allowed, so the two renders agree. */
export function getReducedMotionServerSnapshot(): boolean {
	return false;
}

/** Whether the visitor asked for reduced motion; `false` on the server and during hydration. */
export function useReducedMotion(): boolean {
	return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, getReducedMotionServerSnapshot);
}

/** What `ThinkingIndicator` accepts. */
export interface ThinkingIndicatorProps {
	/** What a screen reader hears, once. Defaults to "Thinking". */
	label?: string;
	/** The verbs to rotate through. Defaults to `THINKING_VERBS`. */
	verbs?: readonly string[];
	/** Extra classes on the wrapper (spacing). */
	className?: string;
}

/** Joins class names, dropping the empty ones. */
function classes(...names: Array<string | undefined>): string {
	return names.filter(Boolean).join(" ");
}

/**
 * The inline `[·]` mark and a rotating verb, for an agent that is thinking. Announced once as
 * `label` through `role="status"`; the verb is decorative.
 */
export function ThinkingIndicator({ label = "Thinking", verbs = THINKING_VERBS, className }: ThinkingIndicatorProps) {
	const reducedMotion = useReducedMotion();
	const [verb, setVerb] = useState(INITIAL_VERB);

	useEffect(
		() =>
			startVerbRotation(
				{
					random: Math.random,
					setTimer: (fn, ms) => window.setTimeout(fn, ms),
					clearTimer: (handle) => window.clearTimeout(handle),
					reducedMotion,
					onVerb: setVerb,
				},
				verbs,
			),
		[reducedMotion, verbs],
	);

	return (
		<span
			data-slot="thinking-indicator"
			data-motion={reducedMotion ? "reduced" : "full"}
			className={classes("ah-loader", className)}
			style={{ position: "relative", gap: 8, fontSize: "var(--text-ui-sm)", color: "var(--text-secondary)" }}
		>
			<span role="status" className="ah-loader__label">
				{label}
			</span>
			<MarkGlyph width={INLINE_PX} height={INLINE_PX} bracketStroke={INLINE_STROKE} aria-hidden="true" />
			<span data-slot="thinking-verb" aria-hidden="true">
				{verb}
			</span>
		</span>
	);
}
