// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useRef, useState } from "react";
import { AlethiaLockup } from "../lockup";

/**
 * The marketing intro splash: `[ Alethia · LABS ]` over "Truth, brought into focus.", once per
 * browser session (polish-wave spec §1, #7735 / #7742). It covers hydration and nothing more.
 *
 * ## What draws it, and what decides when it goes
 *
 * All motion is CSS (`.ah-intro*` in `../tokens.css`). It starts on first paint from the server's
 * HTML, before any JavaScript runs, so the sequence is the same however slow the bundle is. This
 * component does two things: it measures the two words (so the lockup's opening geometry is exact
 * once fonts are in), and it decides when the overlay leaves.
 *
 * Whether it shows at all is decided earlier still, by the inline `<head>` script in
 * `./intro-gate.ts`: a repeat load in the same session puts `data-intro="skip"` on `<html>` and
 * the overlay is `display: none` before it can paint.
 *
 * ## Invariants, each one a production bug in the loader this ports
 *
 * - **Dismissal is decided in a `useEffect`**: its body running means React has hydrated, which is
 *   the only question being asked. Never the `window` `load` event, which waits for the last
 *   subresource and kept an interactive app covered for seconds.
 * - **`pointer-events: none` is on the overlay element itself.** The exit keeps it mounted and
 *   full-screen while it fades; an invisible overlay that still eats clicks is worse than none.
 * - **`bg-background` / `text-foreground`**, never a hardcoded black: light mode must not flash.
 * - **Render never branches on reduced motion.** The server cannot read the media query, so a
 *   render that did would disagree with the client's first render. The reduced-motion look (the
 *   complete lockup, no motion) is a CSS `@media` block; the one behavioural difference (no exit
 *   fade) is read from `matchMedia` inside a timer, after hydration, where it cannot mismatch.
 * - **The scroll lock is released when dismissal is decided**, not at unmount, which the exit fade
 *   defers by 240ms.
 * - **`aria-hidden`.** It repeats the site name and a motto; a screen reader gets the page.
 *
 * ## The words do not unfold through `max-width`
 *
 * The spec describes the unfold as `max-width` 0 → measured, the header's fold in reverse. An
 * animated `max-width` re-lays out the lockup every frame, and every frame moves the brackets and
 * the dot: those are layout shifts, which would put the splash into CLS, and the spec's acceptance
 * is CLS 0. So the lockup is laid out at its final width from the first frame and the same picture
 * is drawn with compositor-only properties: the brackets and dot start at their compact `[·]`
 * offsets (`transform`) and travel out, and each word is revealed from the dot with `clip-path`
 * while its letters slide out of the dot, exactly as the header fold slides them in.
 */

/**
 * Long enough that a warm load reads as a beat rather than a flicker, short enough that nobody
 * waits on it. Measured from navigation start, which is when the server's HTML can first paint.
 */
export const INTRO_FLOOR_MS = 420;

/**
 * The latest the overlay starts to leave. JavaScript cannot enforce this: if hydration is late,
 * no effect has run yet. So the cap is the CSS `ah-intro-out` animation on `.ah-intro`, which
 * fades the overlay at this time with or without React. Kept here so the test can hold the two
 * numbers together.
 */
export const INTRO_CAP_MS = 1150;

/** The exit fade, `cubic-bezier(.22,1,.36,1)` in `tokens.css`. */
export const INTRO_EXIT_MS = 240;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The overlay's life: on screen, fading out, unmounted. */
export type IntroPhase = "shown" | "leaving" | "gone";

/** The slice of `<html>` the splash touches: the gate's verdict in, its scroll lock out. */
export interface IntroRoot {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
}

/**
 * Everything `startIntro` needs from the browser, injected so the dismissal logic runs under
 * fake timers in a test without a DOM. `H` is the timer handle type (a number in a browser).
 */
export interface IntroHost<H> {
	/** `document.documentElement`. */
	root: IntroRoot;
	/** Milliseconds since navigation start (`performance.now()`). */
	now(): number;
	/** Schedules `fn` after `ms`. */
	setTimer(fn: () => void, ms: number): H;
	/** Cancels a timer from `setTimer`. */
	clearTimer(handle: H): void;
	/** Whether the visitor asked for reduced motion, read when dismissal fires. */
	reducedMotion(): boolean;
	/** Moves the overlay to the next phase. */
	setPhase(phase: IntroPhase): void;
}

/** The attribute on `<html>` that the CSS scroll lock (`html[data-intro-lock]`) keys on. */
export const INTRO_LOCK_ATTR = "data-intro-lock";

/**
 * How long after hydration the overlay should start to leave: whatever is left of the floor, or
 * nothing if the floor has passed. Never more than the floor, so hydration plus this is bounded
 * by the floor or by hydration, whichever is later; the CSS cap bounds hydration.
 */
export function introDismissDelay(elapsedMs: number): number {
	return Math.max(0, INTRO_FLOOR_MS - elapsedMs);
}

/**
 * Runs the splash's dismissal from hydration. Returns the cleanup for the effect.
 *
 * A skipped session (the gate set `data-intro="skip"`) unmounts at once and never locks scroll.
 * Otherwise it locks scroll, waits out the floor, releases the lock in the same tick it decides
 * to leave, then fades (or, under reduced motion, unmounts without a fade).
 */
export function startIntro<H>(host: IntroHost<H>): () => void {
	if (host.root.getAttribute("data-intro") === "skip") {
		host.setPhase("gone");
		return () => {};
	}

	// An attribute of our own rather than `body.style.overflow`: writing the shared property is how
	// a splash stomps the lock of a dialog that opened during its window. Removing our attribute
	// cannot release anyone else's hold.
	host.root.setAttribute(INTRO_LOCK_ATTR, "");
	let locked = true;
	/** Idempotent: the decision and the cleanup may both call it. */
	const releaseLock = () => {
		if (!locked) return;
		locked = false;
		host.root.removeAttribute(INTRO_LOCK_ATTR);
	};

	let exitTimer: H | null = null;
	const leaveTimer = host.setTimer(() => {
		releaseLock();
		if (host.reducedMotion()) {
			host.setPhase("gone");
			return;
		}
		host.setPhase("leaving");
		exitTimer = host.setTimer(() => host.setPhase("gone"), INTRO_EXIT_MS);
	}, introDismissDelay(host.now()));

	return () => {
		host.clearTimer(leaveTimer);
		if (exitTimer !== null) host.clearTimer(exitTimer);
		releaseLock();
	};
}

/**
 * Writes each word's natural width onto the lockup as `--intro-wa` / `--intro-wl`, the lengths the
 * CSS derives the compact `[·]` offsets from. Until this runs the stylesheet's em estimates stand
 * in, so a late hydration only costs a few px of accuracy in the brackets' starting point.
 */
function measureWords(overlay: HTMLElement): void {
	const lockup = overlay.querySelector<HTMLElement>(".ah-mark");
	if (!lockup) return;
	const pairs: Array<[string, string]> = [
		[".ah-mark__alethia > span", "--intro-wa"],
		[".ah-mark__labs > span", "--intro-wl"],
	];
	for (const [selector, prop] of pairs) {
		const inner = lockup.querySelector<HTMLElement>(selector);
		if (inner) lockup.style.setProperty(prop, `${inner.scrollWidth}px`);
	}
}

/**
 * The once-per-session intro splash. Mount it once, first inside `<body>` of the marketing root
 * layout, alongside the gate script from `./intro-gate.ts` in `<head>`; without the gate it would
 * play on every hard load.
 */
export function IntroSplash() {
	const [phase, setPhase] = useState<IntroPhase>("shown");
	const overlay = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const node = overlay.current;
		let alive = true;
		if (node) {
			measureWords(node);
			// The first measure can run on the fallback face; measure again once the real faces are in.
			void document.fonts.ready.then(() => {
				if (alive) measureWords(node);
			});
		}
		const stop = startIntro<number>({
			root: document.documentElement,
			now: () => performance.now(),
			setTimer: (fn, ms) => window.setTimeout(fn, ms),
			clearTimer: (handle) => window.clearTimeout(handle),
			reducedMotion: () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
			setPhase,
		});
		return () => {
			alive = false;
			stop();
		};
		// One-shot: the splash lives once per page load.
	}, []);

	if (phase === "gone") return null;

	return (
		<div
			ref={overlay}
			className="ah-intro pointer-events-none bg-background text-foreground"
			data-leaving={phase === "leaving" ? "" : undefined}
			aria-hidden="true"
		>
			<div className="ah-intro__stack">
				<AlethiaLockup tag="labs" />
				<p className="ah-intro__motto">Truth, brought into focus.</p>
			</div>
		</div>
	);
}
