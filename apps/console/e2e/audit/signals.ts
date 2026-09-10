// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R5 (axe), R6 (console + network) and R7 (interactive budget) — the three predicates that come
// from instrumenting the page rather than measuring its geometry.
//
// All three REUSE the existing helpers (`helpers/a11y.ts`, `helpers/console-errors.ts`,
// `helpers/perf.ts`) rather than growing a second copy. Where a helper's behaviour is wrong for a
// GATE — as opposed to wrong for the QA report it was written for — this file says so out loud and
// closes the gap here, because those helpers are shared with suites that are not gates.

import type { Page } from "@playwright/test";
import { scanA11y, type A11yTheme, type ThemedA11yViolation } from "../helpers/a11y";
import { attachConsoleGuard, type CapturedError, type ConsoleGuard } from "../helpers/console-errors";
import { attachPerf, type PerfCollector, type PerfRecord } from "../helpers/perf";

/**
 * R5's precondition: axe must actually be there.
 *
 * `helpers/a11y.ts` returns `[]` when `@axe-core/playwright` cannot be imported — deliberately, so
 * the QA suite still runs without it. For a GATE that is the worst possible behaviour: a silent
 * empty result is indistinguishable from a clean page, so every route would score R5 PASS on the
 * strength of the scanner being absent. The helper is outside this unit's scope, so the raise lives
 * here: the audit refuses to start unless the import resolves.
 *
 * Called once per run, from the audit's `beforeAll`, so the run dies at the top rather than 40
 * routes later.
 */
export async function requireAxe(): Promise<void> {
	try {
		const mod = await import("@axe-core/playwright");
		if (typeof mod.default !== "function") {
			throw new Error("@axe-core/playwright resolved but exports no default AxeBuilder");
		}
	} catch (err) {
		throw new Error(
			"R5 cannot be measured: @axe-core/playwright did not import, so `scanA11y()` would return " +
				"[] and EVERY route would score a clean a11y pass on the strength of the scanner being " +
				"missing. Install it (apps/console devDependency) before running the audit.\n  cause: " +
				String(err),
		);
	}
}

/**
 * The two paints R5 scores. BOTH, every route, every run (#4195).
 *
 * `app/layout.tsx` sets `defaultTheme="system" enableSystem`, and Playwright's default
 * `colorScheme` is `light` — so until this existed every R5 verdict the audit had ever emitted was a
 * light-mode verdict published as THE verdict. R5 is declared never-N/A, which made the dark half a
 * WITHHELD MEASUREMENT: a number that covered one theme with nothing to say so. The arithmetic
 * behind #4195 said dark fails harder (`gray600` on `#171717` at 3.78:1) than the light failure
 * being fixed; this is what turns that arithmetic into a measurement.
 *
 * DARK FIRST, LIGHT LAST, and the order is load-bearing. The predicates measured after R5 (R2's
 * overlay probes especially) expect the paint the audit has always handed them, so the page must
 * come back light. Doing that in a `finally` meant a throw inside the cleanup REPLACED the real
 * error — an axe failure, or the 180 s timeout tearing the page down mid-`analyze()`, would surface
 * as "Execution context was destroyed" from `emulateMedia`, and the `record()` after the loop never
 * ran, so the route got no R5 row at all: neither PASS, FAIL nor NOT MEASURED. Ending on light
 * makes the last scan's own state the hand-back and lets the `finally` go.
 */
export const AUDIT_THEMES: readonly A11yTheme[] = ["dark", "light"];

/** What the page looked like after a theme was asked for — the evidence that it applied. */
export interface ThemeApplied {
	theme: A11yTheme;
	/** The `<html>` class list agreed with the theme asked for, within the wait. */
	applied: boolean;
	htmlClass: string;
	/** `getComputedStyle(body).backgroundColor` — the paint, not the class name. */
	background: string;
	/** next-themes' stored preference; anything but `system`/absent explains a theme that will not follow the OS. */
	storedPreference: string | null;
}

/**
 * Everything about the painted page R5 records, in ONE round trip.
 *
 * Read once, AFTER the wait has already settled the class — the class is the thing being awaited,
 * and the paint and the stored preference only have to be true of the state the wait arrived at.
 */
async function readPaint(page: Page): Promise<Omit<ThemeApplied, "theme" | "applied">> {
	return page.evaluate(() => {
		let storedPreference: string | null = null;
		try {
			storedPreference = localStorage.getItem("theme");
		} catch {
			storedPreference = null;
		}
		return {
			htmlClass: document.documentElement.className,
			background: getComputedStyle(document.body).backgroundColor,
			storedPreference,
		};
	});
}

/**
 * Ask the page for `theme` the way the operating system would, and wait until it has answered.
 *
 * `emulateMedia({ colorScheme })` flips `prefers-color-scheme`; next-themes (`attribute="class"`,
 * `enableSystem`) listens to that media query and toggles `dark` on `<html>`. Nothing is written
 * to storage and no toggle is clicked — this is the exact path a person on a dark-mode OS takes.
 *
 * It RETURNS whether the theme applied rather than assuming it. A broken listener, a persona whose
 * stored preference pins one theme, or a provider that stopped honouring `system` would otherwise
 * produce a dark column that is really the light one measured twice — the failure #4195 names.
 *
 * The wait is `page.waitForFunction`, which this audit already uses for exactly this shape
 * (`error-state.ts`): it polls IN-PAGE on rAF rather than costing a CDP round trip per tick. The
 * hand-rolled 100 ms loop it replaces re-read `getComputedStyle(body)` on every tick though only
 * the class was being awaited — up to 30 evaluates per apply, and a full 3 s ceiling twice on any
 * page that does not follow the media query, for a class next-themes toggles synchronously in its
 * `change` listener.
 */
export async function applyTheme(page: Page, theme: A11yTheme, timeoutMs = 3_000): Promise<ThemeApplied> {
	await page.emulateMedia({ colorScheme: theme });
	const wantDark = theme === "dark";
	let applied = true;
	try {
		await page.waitForFunction(
			(want) => document.documentElement.classList.contains("dark") === want,
			wantDark,
			{ timeout: timeoutMs },
		);
	} catch {
		// The predicate never came true inside the wait. That is the measurement, not an error:
		// `applied: false` is what the caller scores, and `htmlClass`/`storedPreference` below are
		// what explain it.
		applied = false;
	}
	return { theme, applied, ...(await readPaint(page)) };
}

/**
 * Turn every CSS transition and animation off for the rest of this page's life.
 *
 * axe's `color-contrast` reads `getComputedStyle` at check time, and `@repo/ui` carries ~29
 * `transition-colors`/`transition-all` sites at the 150 ms default while the console does NOT set
 * next-themes' `disableTransitionOnChange`. Scanning the instant the `dark` class lands therefore
 * reads nodes mid-transition: a foreground/background pair that exists in NEITHER theme, a verdict
 * that flips between runs, and a recorded colour that matches no token — the unreproducible red
 * that #4099's evidence was built to end. This is what `disableTransitionOnChange` does, held for
 * the whole scan instead of one frame.
 *
 * Returns a remover so the suppression does not outlive R5: R7's interactive timings and R2's
 * overlay probes are measured on the page as it really animates.
 */
async function suppressTransitions(page: Page): Promise<() => Promise<void>> {
	const handle = await page.addStyleTag({
		content: "*,*::before,*::after{transition:none!important;animation:none!important}",
	});
	return async () => {
		// A route that client-side navigated mid-scan has already discarded the tag; that is the
		// same end state, so a stale handle is not a failure.
		//
		// `addStyleTag` hands back an `ElementHandle<Node>`, and `remove()` is on `Element` — narrowed
		// with `instanceof` rather than an `as`, which also makes a handle to something that is no
		// longer an element a no-op instead of a throw.
		await handle
			.evaluate((el) => {
				if (el instanceof Element) el.remove();
			})
			.catch(() => undefined);
	};
}

/** What one R5 scan measured: the axe violations, and the paints they were measured in. */
export interface RouteThemeScan {
	violations: ThemedA11yViolation[];
	/** One entry per {@link AUDIT_THEMES} entry, in the order they were asked for. */
	themes: ThemeApplied[];
}

/**
 * Whether the console answers the OS at all — the positive control behind every R5 verdict.
 *
 * Whether dark applies is a property of the PROVIDER and the storage state, not of each route, so
 * it is measured once per run and not re-litigated 40 times. It is a control in the sense
 * `measurementControl` is: it drives the instrument against a page whose answer is known, and
 * names the predicate to withhold when the instrument stops answering.
 *
 * This exists because the alternative already shipped once and was worse. A theme that failed to
 * apply used to be FABRICATED as an axe violation — `theme-did-not-apply`, `impact: "critical"`,
 * with invented `groups`/`checks`/`omittedNodes` so the scoreboard's R5 summariser would not refuse
 * it. A next-themes regression, or a persona whose storage pins `theme` (`capture.setup.ts` writes
 * one), would then put ~40 routes in the R5 FAIL column with the cause buried in `checks[0].data`
 * where the summariser never prints it; `--import-live` would bake them into the live baseline, the
 * ratchet would block unrelated console PRs, and `LIVE_DEBT.R5` would attribute the whole red column
 * to the token work. `report.ts` already has the first-class shape for a claim about the instrument
 * rather than the page — `NOT MEASURED` via `withhold()` — and this is what feeds it.
 *
 * @returns the reasons R5 must be withheld for the run; empty means the control held.
 */
export async function darkThemeControl(page: Page): Promise<string[]> {
	const broken: string[] = [];
	const dark = await applyTheme(page, "dark");
	const light = await applyTheme(page, "light");
	if (!dark.applied) {
		broken.push(
			`asked for the dark theme and <html> never carried the \`dark\` class (class="${dark.htmlClass}", ` +
				`stored theme preference ${dark.storedPreference === null ? "absent" : `"${dark.storedPreference}"`})`,
		);
	}
	if (!light.applied) {
		broken.push(
			`asked for the light theme and <html> kept the \`dark\` class (class="${light.htmlClass}", ` +
				`stored theme preference ${light.storedPreference === null ? "absent" : `"${light.storedPreference}"`})`,
		);
	}
	// The CLASS moving is not the measurement — the PAINT is. A provider that toggles the class
	// against a stylesheet that no longer varies would otherwise pass a control that exists to
	// prove the dark scan is not the light one measured twice.
	if (dark.applied && light.applied && dark.background === light.background) {
		broken.push(
			`both themes painted the same background (${dark.background}) — the dark scan would be the light paint again`,
		);
	}
	return broken;
}

/**
 * R5 — serious/critical axe violations at wcag2a/wcag2aa, in EVERY theme, each violation naming
 * the theme it was seen in.
 *
 * Transitions are suppressed for the duration (see {@link suppressTransitions}) and restored after,
 * and the loop ENDS on light (see {@link AUDIT_THEMES}), so the page is handed to the predicates
 * measured after R5 in the paint they have always seen — without a `finally` that could swallow the
 * real error.
 *
 * A theme that did not apply is reported as `applied: false` on its {@link ThemeApplied} entry and
 * is NOT scanned; it is never a fabricated axe violation. The caller scores it, and
 * {@link darkThemeControl} is what turns a systematic failure into a withheld predicate.
 */
export async function scanRouteThemes(page: Page): Promise<RouteThemeScan> {
	const violations: ThemedA11yViolation[] = [];
	const themes: ThemeApplied[] = [];
	const restoreTransitions = await suppressTransitions(page);
	try {
		for (const theme of AUDIT_THEMES) {
			const applied = await applyTheme(page, theme);
			themes.push(applied);
			if (!applied.applied) continue;
			// `theme` is stamped HERE rather than trusted from the helper's optional field, which is
			// what makes it required on the way out: a per-theme count built from these cannot report
			// 0 for a violation that never named one.
			for (const violation of await scanA11y(page, { theme })) {
				violations.push({ ...violation, theme });
			}
		}
	} finally {
		// Safe in a `finally` where `applyTheme` was not: the remover swallows a stale handle, so it
		// cannot throw and cannot replace the error the try block is carrying.
		await restoreTransitions();
	}
	return { violations, themes };
}

export interface RouteSignals {
	guard: ConsoleGuard;
	perf: PerfCollector;
	/** Console errors the SHARED helper's dev-noise allowlist suppresses but a gate must not. */
	suppressedButReal: CapturedError[];
}

/**
 * Attach R6 + R7 instrumentation to a page, for the lifetime of that page.
 *
 * `attachConsoleGuard` carries an ALLOWLIST of dev-mode noise — including `/hydration/i` and
 * `validateDOMNesting`. That is a reasonable default for the QA report it was written for, and
 * wrong for THIS gate: the CI job drives a BUILT console, where a hydration mismatch is a shipped
 * defect and not a warning a developer sees and dismisses. So the guard is reused for capture, and
 * one extra listener re-captures exactly the classes it drops that this run must not treat as
 * noise. It is not a second console guard — it never grows past this list, and the list is here so
 * the next reader can see what it is compensating for.
 *
 * (A sandbox environment serves the console from a development server, so those classes really can
 * be noise there. They are still reported: a finding a reader can dismiss beats one nobody is shown.)
 */
export function attachSignals(page: Page): RouteSignals {
	const guard = attachConsoleGuard(page);
	const perf = attachPerf(page);
	const suppressedButReal: CapturedError[] = [];
	const REAL_IN_PRODUCTION = [/hydration/i, /validateDOMNesting/i];
	const capture = (text: string, kind: CapturedError["kind"]) => {
		if (!REAL_IN_PRODUCTION.some((re) => re.test(text))) return;
		// ONLY WHAT THE GUARD ACTUALLY DROPPED. These patterns are deliberately broader than the
		// guard's — its entry is `/Warning: .*validateDOMNesting/i`, and React 19 logs most of those
		// without the `Warning: ` prefix — so a message the guard already captured would be counted
		// a second time here, appearing twice in the R6 evidence and inflating the failure count.
		// Mirroring the guard's exact regexes would be a copy that decays; asking what it captured
		// is the same question, answered by the emitter.
		if (guard.errors.some((e) => e.text === text)) return;
		suppressedButReal.push({ kind, text, at: new Date().toISOString() });
	};
	page.on("console", (msg) => {
		if (msg.type() === "error") capture(msg.text(), "console");
	});
	page.on("pageerror", (err) => capture(err.message ?? String(err), "pageerror"));
	return { guard, perf, suppressedButReal };
}

/** Everything R6 counts against a route: console errors, page errors, and responses >= 400. */
export function r6Failures(signals: RouteSignals): CapturedError[] {
	return [...signals.guard.errors, ...signals.suppressedButReal];
}

/**
 * R7 — nearest-rank p95 of the route's interactive times.
 *
 * NOTHING IS HIDDEN BY THE STATISTIC. A route is loaded once per viewport width and the first load
 * is excluded as a warm-up (see routes.spec.ts), so n = 3 and the nearest-rank p95
 * (`ceil(0.95 · 3)` = 3) is the SLOWEST of the three. That is said here rather than left for a
 * reader to work out, because a "p95" over three samples that quietly reported the median would let
 * the worst viewport regress without moving the number.
 */
export function p95(samples: number[]): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * The budget a route's p95 interactive time must come in under.
 *
 * ONE default rather than a per-route table, deliberately: a hand-written per-route budget list is
 * a subject list that decays — a route added later gets no entry and no gate. The default is a
 * CEILING that catches a pathological regression (a page that went from ~1s to ~8s), not a
 * performance target; the scoreboard records the measured p95 per route so the ratchet, when it
 * lands, tightens from real numbers rather than from a guess made today.
 *
 * `AUDIT_R7_BUDGET_MS` overrides it for a slow or contended machine.
 */
export const R7_BUDGET_MS = Number(process.env.AUDIT_R7_BUDGET_MS ?? 8_000);

/** Navigation records perf.ts collected for one path — the request-level evidence behind R7. */
export function navigationsFor(perf: PerfCollector, sincePathPrefix: string): PerfRecord[] {
	return perf.records.filter((r) => r.kind === "navigation" && r.path.startsWith(sincePathPrefix));
}
