// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The intro splash (#7742). No DOM here, like the rest of this package's tests: the markup is the
// server render (which is what a visitor's first paint is), the dismissal is `startIntro` driven
// by fake timers through its injected host, and the once-per-session gate is the inline script
// itself, run in a fresh VM context. The CSS half of each invariant is read from tokens.css,
// because for this component the stylesheet IS the behaviour before hydration.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTRO_GATE_SCRIPT, INTRO_SEEN_KEY } from "../src/site/intro-gate";
import {
	INTRO_CAP_MS,
	INTRO_EXIT_MS,
	INTRO_FLOOR_MS,
	INTRO_LOCK_ATTR,
	IntroSplash,
	introDismissDelay,
	startIntro,
	type IntroHost,
	type IntroPhase,
} from "../src/site/intro-splash";

const TOKENS = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

/** A stand-in for `<html>`: an attribute map. */
function fakeRoot(initial: Record<string, string> = {}) {
	const attrs = new Map(Object.entries(initial));
	return {
		attrs,
		getAttribute: (name: string) => attrs.get(name) ?? null,
		setAttribute: (name: string, value: string) => {
			attrs.set(name, value);
		},
		removeAttribute: (name: string) => {
			attrs.delete(name);
		},
	};
}

type Timer = ReturnType<typeof setTimeout>;

/** A host on vitest's fake timers, recording every phase the splash moves to. */
function fakeHost(opts: { elapsed?: number; reduced?: boolean; root?: Record<string, string> } = {}) {
	const root = fakeRoot(opts.root);
	const phases: IntroPhase[] = [];
	const host: IntroHost<Timer> = {
		root,
		now: () => opts.elapsed ?? 0,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle),
		reducedMotion: () => opts.reduced ?? false,
		setPhase: (phase) => {
			phases.push(phase);
		},
	};
	return { host, root, phases };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("IntroSplash markup", () => {
	const html = renderToStaticMarkup(<IntroSplash />);

	it("renders the overlay aria-hidden, pointer-events-none, on the theme tokens", () => {
		const overlay = html.match(/^<div([^>]*)>/)?.[1] ?? "";
		expect(overlay).toContain('aria-hidden="true"');
		const classes = overlay.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
		expect(classes).toEqual(expect.arrayContaining(["ah-intro", "pointer-events-none", "bg-background", "text-foreground"]));
		// The stylesheet carries it too, on the overlay rule itself, not a parent.
		expect(TOKENS).toMatch(/\.ah-intro \{[^}]*pointer-events: none;/);
		expect(TOKENS).toMatch(/\.ah-intro \{[^}]*z-index: var\(--z-overlay\);/);
	});

	it("draws the lockup and the motto", () => {
		expect(html).toContain("Alethia");
		expect(html).toContain("LABS");
		expect(html).toContain("ah-mark__dot");
		expect(html).toContain("Truth, brought into focus.");
	});

	it("renders the same thing whatever the motion setting, so hydration cannot mismatch", () => {
		expect(html).not.toMatch(/reduce|data-motion/);
		expect(html).not.toContain("data-leaving");
	});
});

describe("startIntro: dismissal", () => {
	it("holds until the floor, then releases the lock, fades, and unmounts", () => {
		const { host, root, phases } = fakeHost({ elapsed: 100 });
		startIntro(host);
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(true);

		vi.advanceTimersByTime(INTRO_FLOOR_MS - 100 - 1);
		expect(phases).toEqual([]);
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(true);

		vi.advanceTimersByTime(1);
		// The lock goes the moment dismissal is decided, not when the fade ends.
		expect(phases).toEqual(["leaving"]);
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(false);

		vi.advanceTimersByTime(INTRO_EXIT_MS);
		expect(phases).toEqual(["leaving", "gone"]);
	});

	it("leaves at once when hydration lands after the floor", () => {
		expect(introDismissDelay(0)).toBe(INTRO_FLOOR_MS);
		expect(introDismissDelay(INTRO_FLOOR_MS + 300)).toBe(0);
		const { host, phases } = fakeHost({ elapsed: 900 });
		startIntro(host);
		vi.advanceTimersByTime(0);
		expect(phases).toEqual(["leaving"]);
	});

	it("caps the overlay in CSS, because a late hydration has no effect to run", () => {
		expect(INTRO_FLOOR_MS).toBeLessThan(INTRO_CAP_MS);
		expect(TOKENS).toContain(`animation: ah-intro-out ${INTRO_EXIT_MS}ms cubic-bezier(.22, 1, .36, 1) ${INTRO_CAP_MS}ms forwards;`);
		expect(TOKENS).toContain(`transition: opacity ${INTRO_EXIT_MS}ms cubic-bezier(.22, 1, .36, 1);`);
	});

	it("releases the lock and changes nothing if it unmounts before the floor", () => {
		const { host, root, phases } = fakeHost();
		const stop = startIntro(host);
		vi.advanceTimersByTime(100);
		stop();
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(false);
		vi.advanceTimersByTime(INTRO_CAP_MS);
		expect(phases).toEqual([]);
	});
});

describe('data-intro="skip": a repeat load in the session', () => {
	it("unmounts at hydration without locking scroll", () => {
		const { host, root, phases } = fakeHost({ root: { "data-intro": "skip" } });
		startIntro(host);
		expect(phases).toEqual(["gone"]);
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(false);
		vi.advanceTimersByTime(INTRO_CAP_MS);
		expect(phases).toEqual(["gone"]);
	});

	it("is hidden by CSS before it can paint", () => {
		expect(TOKENS).toContain('[data-intro="skip"] .ah-intro { display: none; }');
	});
});

describe("the once-per-session gate script", () => {
	/** Runs the inline script against a fake `<html>` and storage, as the browser would. */
	function runGate(storage: unknown) {
		const root = fakeRoot();
		runInNewContext(INTRO_GATE_SCRIPT, { document: { documentElement: root }, sessionStorage: storage });
		return root;
	}

	/** An in-memory `sessionStorage`. */
	function memoryStorage() {
		const items = new Map<string, string>();
		return {
			items,
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => {
				items.set(key, value);
			},
		};
	}

	it("lets the first load play and marks the session", () => {
		const storage = memoryStorage();
		const root = runGate(storage);
		expect(root.getAttribute("data-intro")).toBeNull();
		expect(storage.items.get(INTRO_SEEN_KEY)).toBe("1");
	});

	it('marks every later load in the session data-intro="skip"', () => {
		const storage = memoryStorage();
		runGate(storage);
		expect(runGate(storage).getAttribute("data-intro")).toBe("skip");
	});

	it("shows nothing, and does not throw, when storage is blocked", () => {
		const blocked = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("SecurityError");
			},
		};
		expect(runGate(blocked).getAttribute("data-intro")).toBe("skip");
	});
});

describe("reduced motion", () => {
	it("leaves at the floor with no fade", () => {
		const { host, root, phases } = fakeHost({ reduced: true });
		startIntro(host);
		vi.advanceTimersByTime(INTRO_FLOOR_MS);
		expect(phases).toEqual(["gone"]);
		expect(root.attrs.has(INTRO_LOCK_ATTR)).toBe(false);
	});

	it("draws the complete lockup with no motion", () => {
		const block = TOKENS.slice(TOKENS.indexOf("Reduced motion: the complete lockup"));
		expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ah-intro \* \{ animation: none !important; \}/);
	});
});
