// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ThinkingIndicator (#7870). No DOM here, like the rest of this package's tests: the markup is the
// server render (what hydrates), and the rotation is `startVerbRotation` driven by fake timers
// through its injected host — the same function the component's effect calls.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	INITIAL_VERB,
	NO_REPEAT_WINDOW,
	ThinkingIndicator,
	VERB_INTERVAL_MS,
	getReducedMotionServerSnapshot,
	pickNextVerb,
	startVerbRotation,
} from "../src/loader/thinking-indicator";
import { BANNED_VERB_STEMS, THINKING_VERBS } from "../src/loader/thinking-verbs";

/** Every word-start suffix of a verb, lower-cased: "Taking a reading…" → "taking a reading", "a reading", "reading". */
function wordStarts(verb: string): string[] {
	const words = verb.toLowerCase().replace(/…$/, "").split(/[\s-]+/);
	return words.map((_, i) => words.slice(i).join(" "));
}

/** A seeded linear congruential generator, so a "random" run is repeatable. */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** A rotation on vitest's fake timers, recording every verb shown. */
function rotate(opts: { reducedMotion?: boolean; random?: () => number; verbs?: readonly string[] } = {}) {
	const shown: string[] = [];
	const stop = startVerbRotation(
		{
			random: opts.random ?? seeded(7),
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle),
			reducedMotion: opts.reducedMotion ?? false,
			onVerb: (verb) => {
				shown.push(verb);
			},
		},
		opts.verbs,
	);
	return { shown, stop };
}

describe("THINKING_VERBS", () => {
	it("holds 200–300 unique entries", () => {
		expect(THINKING_VERBS.length).toBeGreaterThanOrEqual(200);
		expect(THINKING_VERBS.length).toBeLessThanOrEqual(300);
		expect(new Set(THINKING_VERBS).size).toBe(THINKING_VERBS.length);
	});

	it("is in the voice: sentence case, ending in an ellipsis, no exclamation, no emoji", () => {
		for (const verb of THINKING_VERBS) {
			expect(verb, verb).toMatch(/^[A-Z][^A-Z]*…$/);
			expect(verb.indexOf("…"), verb).toBe(verb.length - 1);
			expect(verb, verb).not.toMatch(/!/);
			expect(verb, verb).not.toMatch(/\p{Extended_Pictographic}/u);
		}
	});

	it("claims no action the agent is not taking", () => {
		const offenders = THINKING_VERBS.filter((verb) =>
			wordStarts(verb).some((start) => BANNED_VERB_STEMS.some((stem) => start.startsWith(stem))),
		);
		expect(offenders).toEqual([]);
	});

	it("bans the verbs the brief names, so the matcher is not vacuous", () => {
		for (const lie of ["Deploying…", "Applying…", "Destroying…", "Applied the plan…", "Rolling back…"]) {
			expect(
				wordStarts(lie).some((start) => BANNED_VERB_STEMS.some((stem) => start.startsWith(stem))),
				lie,
			).toBe(true);
		}
	});

	it("contains the server render's verb", () => {
		expect(THINKING_VERBS).toContain(INITIAL_VERB);
	});
});

describe("rotation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a random first verb straight away", () => {
		const first = rotate({ random: () => 0.5 }).shown;
		expect(first).toEqual([pickNextVerb(THINKING_VERBS, [], () => 0.5)]);
		expect(first[0]).toBe(THINKING_VERBS[Math.floor(0.5 * THINKING_VERBS.length)]);
		expect(rotate({ random: () => 0 }).shown[0]).not.toBe(first[0]);
	});

	it("changes verb every interval, and not before", () => {
		const { shown, stop } = rotate();
		expect(shown).toHaveLength(1);
		vi.advanceTimersByTime(VERB_INTERVAL_MS - 1);
		expect(shown).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(shown).toHaveLength(2);
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 3);
		expect(shown).toHaveLength(5);
		stop();
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 10);
		expect(shown).toHaveLength(5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never repeats any of the last NO_REPEAT_WINDOW verbs over a long run", () => {
		const { shown, stop } = rotate({ random: seeded(42) });
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 2000);
		stop();
		expect(shown.length).toBe(2001);
		for (let i = 1; i < shown.length; i++) {
			const window = shown.slice(Math.max(0, i - NO_REPEAT_WINDOW), i);
			expect(window, `step ${i}`).not.toContain(shown[i]);
		}
	});

	it("holds the window even when random() always says the same thing", () => {
		const verbs = Array.from({ length: 30 }, (_, i) => `Verb ${i}…`);
		const { shown, stop } = rotate({ random: () => 0, verbs });
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 100);
		stop();
		for (let i = 1; i < shown.length; i++) {
			expect(shown.slice(Math.max(0, i - NO_REPEAT_WINDOW), i)).not.toContain(shown[i]);
		}
	});

	it("still rotates a list shorter than the window", () => {
		const verbs = ["A…", "B…", "C…"];
		const { shown, stop } = rotate({ random: () => 0, verbs });
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 5);
		stop();
		expect(shown).toEqual(["A…", "B…", "C…", "A…", "B…", "C…"]);
	});
});

describe("reduced motion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fixes the verb: one pick, no timer", () => {
		const { shown, stop } = rotate({ reducedMotion: true });
		expect(shown).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(VERB_INTERVAL_MS * 20);
		expect(shown).toHaveLength(1);
		stop();
	});

	it("is false on the server, so the server render and hydration agree", () => {
		expect(getReducedMotionServerSnapshot()).toBe(false);
		const html = renderToStaticMarkup(<ThinkingIndicator />);
		expect(html).toContain('data-motion="full"');
	});
});

describe("markup", () => {
	const html = renderToStaticMarkup(<ThinkingIndicator />);

	it("announces the label once, through exactly one status region", () => {
		expect(html.match(/role="status"/g)).toHaveLength(1);
		const region = /<span role="status"[^>]*>([^<]*)<\/span>/.exec(html);
		expect(region?.[1]).toBe("Thinking");
	});

	it("keeps the rotating verb out of the status region and hidden from assistive tech", () => {
		const verb = /<span data-slot="thinking-verb"([^>]*)>([^<]*)<\/span>/.exec(html);
		expect(verb?.[1]).toContain('aria-hidden="true"');
		expect(verb?.[2]).toBe(INITIAL_VERB);
		const region = /<span role="status"[^>]*>[^<]*<\/span>/.exec(html)?.[0] ?? "";
		expect(region).not.toContain(INITIAL_VERB);
	});

	it("draws the inline mark, decorative", () => {
		expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-slot="mark-glyph"|<svg[^>]*data-slot="mark-glyph"[^>]*aria-hidden="true"/);
	});

	it("takes a custom label", () => {
		expect(renderToStaticMarkup(<ThinkingIndicator label="Reasoning about the plan" />)).toContain(
			">Reasoning about the plan</span>",
		);
	});

	it("sizes its text on a ui rung, never a hardcoded px value", () => {
		expect(html).toContain("font-size:var(--text-ui-sm)");
	});
});
