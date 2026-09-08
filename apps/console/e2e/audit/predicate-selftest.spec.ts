// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Does each predicate actually FAIL when the thing it names is wrong?
//
// A fail-closed assertion nothing exercises is indistinguishable from one that does not work, and
// this repo has shipped that exact class more than once — a guard whose "nothing found" branch and
// whose "nothing wrong" branch were the same line. So every predicate below is driven against a
// page that VIOLATES it and a page that does not, and both directions are asserted. The violating
// fixtures are hand-built markup on purpose: they are the smallest thing that exhibits the defect,
// so a failure here is unambiguously the measurement's, never a console page's.
//
// R2's negative is not invented. It is the shape `packages/ui/src/popover.tsx` records as SHIPPED:
// a popup that names `z-index` while sitting at `position: static`, on which z-index is a no-op, so
// a later positioned sibling paints straight over it. A z-index matcher reads that page as correct.
// The hit test does not.

import { expect, test, type Page } from "@playwright/test";
import { errorStateSignature, rendersSharedErrorState } from "./error-state";
import { hitTest } from "./overlays";
import {
	controlFixture,
	measurementControl,
	measurePage,
	MEASURED_BY,
	type Measure,
	type MeasuredPredicate,
} from "./predicates";
import { createReport, NA_REASONS } from "./report";
import { AUDIT_THEMES, darkThemeControl, scanRouteThemes } from "./signals";

/**
 * Hit-test the overlay carrying `slot`, handed over as the ELEMENT the way `probeOverlays` does.
 *
 * `hitTest` takes a handle rather than a selector precisely so the node measured is the node that
 * opened; passing one here keeps the self-test on the same path the audit uses.
 */
async function hitTestSlot(page: Page, slot: string) {
	const handle = await page.locator(`[data-slot="${slot}"]`).first().elementHandle();
	expect(handle, `no [data-slot="${slot}"] in the fixture`).not.toBeNull();
	if (!handle) throw new Error(`no [data-slot="${slot}"]`);
	try {
		return await hitTest(page, handle);
	} finally {
		await handle.dispose();
	}
}

const CHROME = `
  <header style="position: fixed; inset: 0 0 auto 0; height: 60px; z-index: 100;
                 background: #123; color: white;">chrome</header>`;

test.describe("the live predicates fail when the page is wrong", () => {
	test("R1, R3, R4 and T5 — the shared positive control fires in both directions", async ({ page }) => {
		// The control is not declared here any more. It lives in `predicates.ts` beside the
		// instrument, because `routes.spec.ts` RUNS it before it scores a single route and withholds
		// whatever it names — the shape `scripts/check-route-states.mjs` already uses. A control that
		// only exists as a test is something that goes red BESIDE a run rather than something the run
		// consults, which is exactly how #3804 happened: R3's control was failing on `dev` while the
		// same job published R3 FAILs for two real routes.
		const control = await measurementControl(page);
		expect(control.lines, "every measurePage predicate answers on a violating page and a clean one").toEqual([]);
		expect(control.broken).toEqual([]);
	});

	test("the control covers every field measurePage actually returns", async ({ page }) => {
		// Derived from the instrument at runtime, not from a hand-written list. A fifth measurement
		// added to `PageMeasurement` with no control behind it is a predicate scored by nothing, and
		// a hand-typed roster of what a guard watches stops covering silently.
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.setContent(controlFixture(`<main>anything</main>`));
		const measured = await measurePage(page, 1280);
		const fields = Object.keys(measured).filter((k) => k !== "width");
		expect(fields.sort(), "every measured field must name the predicate it is scored from").toEqual(
			Object.keys(MEASURED_BY).sort(),
		);
	});

	test("the control's fixtures render in the mode the console runs in", async ({ page }) => {
		// #3804, pinned. `page.setContent` with no doctype is QUIRKS mode, and R3 cannot see a
		// scrolling document there: `document.scrollingElement` is `<body>`, whose `overflow-y` is
		// `visible` so the walk skips it, and `documentElement.scrollHeight` equals its own
		// `clientHeight` so that candidate is skipped too. Zero containers, from a 4000px page.
		//
		// This is asserted in BOTH modes on purpose. The defect is the fixture's, not the walk's —
		// the console is a Next.js app and serves a real doctype — so the record of what quirks mode
		// does has to stay here, or the next reader "simplifies" `controlFixture` away and the
		// control silently stops controlling for the second time.
		await page.setViewportSize({ width: 1280, height: 400 });

		await page.setContent(`<div style="height: 4000px">tall</div>`);
		expect(await page.evaluate(() => document.compatMode), "no doctype is quirks mode").toBe("BackCompat");
		expect(await page.evaluate(() => document.scrollingElement?.tagName)).toBe("BODY");
		expect(
			(await measurePage(page, 1280)).scrollContainers,
			"and in quirks mode a 4000px document reports NO scroll container — this is #3804",
		).toEqual([]);

		await page.setContent(controlFixture(`<div style="height: 4000px">tall</div>`));
		expect(await page.evaluate(() => document.compatMode), "controlFixture is standards mode").toBe("CSS1Compat");
		expect(await page.evaluate(() => document.scrollingElement?.tagName)).toBe("HTML");
		const doc = (await measurePage(page, 1280)).scrollContainers;
		expect(doc, "a document that overflows is ONE container").toHaveLength(1);
		expect(doc[0].isShellScroller, "the document IS the shell scroller here").toBe(true);
	});

	// Each mutant is the REAL measurement with one field neutered — not a re-implementation of it,
	// which would only verify a copy. A control that cannot name the predicate that stopped firing
	// is a control that will withhold everything, or nothing, on the day it matters.
	const MUTANTS: { predicate: MeasuredPredicate; what: string; measure: Measure }[] = [
		{
			predicate: "R1",
			what: "overflow stops naming offenders",
			measure: async (p, w) => {
				const m = await measurePage(p, w);
				return { ...m, overflow: { ...m.overflow, offenders: [] } };
			},
		},
		{
			predicate: "R3",
			what: "the scroll walk finds nothing",
			measure: async (p, w) => ({ ...(await measurePage(p, w)), scrollContainers: [] }),
		},
		{
			predicate: "R4",
			what: "the overlap pass finds nothing",
			measure: async (p, w) => ({ ...(await measurePage(p, w)), overlaps: [] }),
		},
		{
			predicate: "T5",
			what: "the hand-rolled empty-state arm finds nothing",
			measure: async (p, w) => {
				const m = await measurePage(p, w);
				return { ...m, empty: { ...m.empty, handRolled: [] } };
			},
		},
	];
	for (const mutant of MUTANTS) {
		test(`the control names ${mutant.predicate} — and only ${mutant.predicate} — when ${mutant.what}`, async ({
			page,
		}) => {
			const control = await measurementControl(page, mutant.measure);
			expect(control.broken, "the broken predicate is named, and no other is withheld with it").toEqual([
				mutant.predicate,
			]);
			expect(control.lines.join("\n")).toContain(`${mutant.predicate}:`);
		});
	}

	test("a withheld predicate publishes NOT MEASURED — not a PASS, not a FAIL, not an N/A", () => {
		// The gate itself, driven. A gate never seen to fire is not known to be a gate, and the whole
		// argument of #3804 is that a verdict from a broken instrument is worse than no verdict.
		const report = createReport();
		report.withhold(["R3"], "positive control failed: R3 measured 0 containers on a scrolling document");

		const withheld = report.record({ route: "/x", url: "/x", predicate: "R3", verdict: "PASS" });
		expect(withheld.verdict, "the caller's PASS is DROPPED, not carried through").toBe("NOT MEASURED");
		expect(withheld.reason).toContain("positive control failed");
		// An N/A is a claim about the PAGE; this is a claim about the instrument. It must not be
		// able to hide in a column that already exists.
		const escaped = report.record({
			route: "/y",
			url: "/y",
			predicate: "R3",
			verdict: "N/A",
			reason: "redirect-only",
		});
		expect(escaped.verdict).toBe("NOT MEASURED");

		const untouched = report.record({ route: "/x", url: "/x", predicate: "R1", verdict: "PASS" });
		expect(untouched.verdict, "a predicate whose control is fine still scores").toBe("PASS");

		const summary = report.summarise();
		expect(summary.R3, "a withheld predicate scores from nothing — null, never 1").toEqual({
			pass: 0,
			fail: 0,
			na: 0,
			notMeasured: 2,
			score: null,
		});
		expect(summary.R1).toEqual({ pass: 1, fail: 0, na: 0, notMeasured: 0, score: 1 });

		// And NOT MEASURED is the recorder's to write. A caller cannot claim it.
		expect(() =>
			createReport().record({ route: "/x", url: "/x", predicate: "R4", verdict: "NOT MEASURED", reason: "meh" }),
		).toThrow(/withhold\(\)/);
		expect(() => createReport().withhold(["R4"], "  ")).toThrow(/without a reason/);
	});

	test("R2 — the hit test catches an overlay that a z-index matcher reads as correct", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });

		// THE SHIPPED SHAPE (packages/ui/src/popover.tsx): the popup names `z-index: 50` but is
		// `position: static`, on which z-index is a no-op — so the later positioned sibling paints
		// over it. Every class-name check passes. The hit test does not.
		await page.setContent(controlFixture(`
			<main style="position: relative; height: 600px">
				<div style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px">
					<div data-slot="popover-content" style="z-index: 50; background: white; border: 1px solid #ccc; height: 200px">
						popover body
					</div>
				</div>
				<div style="position: absolute; left: 60px; top: 60px; width: 500px; height: 400px; background: rgba(255,0,0,.4)">
					a later positioned sibling
				</div>
			</main>`));
		const behind = await hitTestSlot(page, "popover-content");
		expect(behind, "the fixture overlay is measurable").not.toBe("off-screen");
		if (behind === "off-screen") return;
		expect(
			behind.points.filter((p) => !p.inside).length,
			`every probed point should have landed OUTSIDE the popover: ${JSON.stringify(behind.points)}`,
		).toBe(behind.points.length);

		// The fix that repo comment records is a `position: relative` — nothing a z-index matcher
		// looks at. With it, the same markup and the same z-index hit-test clean.
		await page.setContent(controlFixture(`
			<main style="position: relative; height: 600px">
				<div style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px">
					<div data-slot="popover-content" style="position: relative; z-index: 50; background: white; border: 1px solid #ccc; height: 200px">
						popover body
					</div>
				</div>
				<div style="position: absolute; left: 60px; top: 60px; width: 500px; height: 400px; background: rgba(255,0,0,.4)">
					a later positioned sibling
				</div>
			</main>`));
		const above = await hitTestSlot(page, "popover-content");
		expect(above).not.toBe("off-screen");
		if (above === "off-screen") return;
		expect(above.points.filter((p) => !p.inside), "the fixed overlay is on top at every probe").toEqual([]);
	});

	test("R2 — an overlay under fixed chrome is caught at the corners, not only the centre", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		// The overlay's centre is clear; only its top edge is under the chrome. A centre-only hit
		// test would call this clean, which is why the rubric names the four inset corners.
		await page.setContent(controlFixture(`
			${CHROME}
			<main style="position: relative; height: 600px">
				<div data-slot="dialog-content" style="position: absolute; left: 200px; top: 20px; width: 400px; height: 300px; z-index: 10; background: white; border: 1px solid #ccc">
					dialog body
				</div>
			</main>`));
		const measured = await hitTestSlot(page, "dialog-content");
		expect(measured).not.toBe("off-screen");
		if (measured === "off-screen") return;
		const missed = measured.points.filter((p) => !p.inside).map((p) => p.name);
		expect(missed, "the corners under the chrome are reported").toEqual(
			expect.arrayContaining(["top-left", "top-right"]),
		);
		expect(measured.points.find((p) => p.name === "centre")?.inside, "the centre alone would pass").toBe(true);
	});

	test("R2 — a pointer-events:none overlay is measured, not skipped", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.setContent(controlFixture(`
			<main style="position: relative; height: 600px">
				<div data-slot="tooltip-content" style="position: absolute; left: 200px; top: 200px; width: 200px; height: 80px; z-index: 10; pointer-events: none; background: #222; color: white">tip</div>
			</main>`));
		const measured = await hitTestSlot(page, "tooltip-content");
		expect(measured).not.toBe("off-screen");
		if (measured === "off-screen") return;
		expect(measured.pointerEventsRelaxed, "the probe records that it had to relax pointer-events").toBe(true);
		expect(measured.points.filter((p) => !p.inside), "and then reads the real stacking").toEqual([]);
	});

	test("T6 — the ErrorState signature is derived from source, and distinguishes a look-alike", async ({ page }) => {
		const arms = errorStateSignature();
		expect(arms.length, "at least one layout arm was read out of error-state.tsx").toBeGreaterThan(0);

		await page.setContent(controlFixture(`<main><div class="${arms[0].join(" ")}"><h1>Couldn't load this page</h1></div></main>`));
		expect(await rendersSharedErrorState(page), "the real component's class set is recognised").toBe(true);

		await page.setContent(controlFixture(`<main><div class="flex items-center justify-center"><h1>Couldn't load this page</h1></div></main>`));
		expect(
			await rendersSharedErrorState(page),
			"a hand-rolled error panel with the same COPY is not the shared component",
		).toBe(false);
	});

	// ── R5 in BOTH themes (#4195) ─────────────────────────────────────────────────────────────
	// A fixture that behaves like the console: next-themes with `attribute="class"` and
	// `enableSystem` toggles `dark` on <html> from `prefers-color-scheme`, which is what
	// `emulateMedia` flips. The dark ink is the only thing that varies between fixtures.
	// Its OWN document rather than `controlFixture`: axe's `html-has-lang` and `document-title` are
	// both SERIOUS at wcag2a, so a fixture without `lang` and a `<title>` fails R5 in every theme
	// and can prove nothing about contrast — measured on the first CI run of #4195.
	const themed = (darkInk: string, opts: { follow?: boolean; repaint?: boolean } = {}) =>
		`<!doctype html><html lang="en"><head><title>R5 theme fixture</title><style>body{margin:0}</style></head><body>
		  <style>
		    body { background: #ffffff; color: #000000; font-size: 16px; }
		    ${opts.repaint === false ? "" : `html.dark body { background: #171717; color: ${darkInk}; }`}
		  </style>
		  ${
				opts.follow === false
					? ""
					: `<script>
		    (function () {
		      var mq = window.matchMedia("(prefers-color-scheme: dark)");
		      function sync() { document.documentElement.classList.toggle("dark", mq.matches); }
		      sync(); mq.addEventListener("change", sync);
		    })();
		  </script>`
			}
		  <p>The quick brown fox jumps over the lazy dog.</p></body></html>`;

	test("R5 — the dark theme is scanned too, and a violation says which theme it came from", async ({ page }) => {
		// #4a4a4a on #171717 is about 2.5:1 — a serious `color-contrast` in dark; black on white in light.
		await page.setContent(themed("#4a4a4a"));
		const { violations, themes } = await scanRouteThemes(page);
		expect(themes.map((t) => t.theme), "every theme in AUDIT_THEMES was asked for").toEqual([...AUDIT_THEMES]);
		expect(themes.every((t) => t.applied), "and every theme applied").toBe(true);
		expect(themes[0].background, "the two themes are two paints").not.toBe(themes[1].background);
		expect(violations.filter((v) => v.theme === "light"), "light is clean").toEqual([]);
		expect(
			violations.filter((v) => v.theme === "dark").map((v) => v.id),
			"dark fails, and the violation names dark",
		).toContain("color-contrast");
		expect(
			await page.evaluate(() => document.documentElement.classList.contains("dark")),
			"the page is handed back in light for the predicates measured after R5",
		).toBe(false);
	});

	test("R5 — a page clean in both themes reports nothing", async ({ page }) => {
		await page.setContent(themed("#ffffff"));
		const { violations, themes } = await scanRouteThemes(page);
		expect(themes).toHaveLength(AUDIT_THEMES.length);
		expect(violations).toEqual([]);
	});

	test("R5 — a theme that does not apply is recorded in `themes`, never fabricated as a violation", async ({
		page,
	}) => {
		await page.setContent(themed("#4a4a4a", { follow: false }));
		const { violations, themes } = await scanRouteThemes(page);
		const dark = themes.find((t) => t.theme === "dark");
		expect(dark?.applied, "nothing toggled `dark` on <html>").toBe(false);
		// A claim about the INSTRUMENT does not go in the page's FAIL column dressed as an axe
		// violation. It belongs to `themes` — which the caller scores and `darkThemeControl`
		// withholds R5 over when it is systematic.
		expect(violations.map((v) => v.id), "no synthetic axe violation").not.toContain("theme-did-not-apply");
		expect(
			violations.filter((v) => v.theme === "dark"),
			"and a theme that never applied is not scanned, so it cannot contribute the other theme's violations",
		).toEqual([]);
	});

	test("R5 — a theme that applies but repaints nothing shows up as one paint, not as a violation", async ({
		page,
	}) => {
		await page.setContent(themed("#4a4a4a", { repaint: false }));
		const { violations, themes } = await scanRouteThemes(page);
		expect(themes.every((t) => t.applied), "the class toggled").toBe(true);
		expect(themes[0].background, "but the paint did not move").toBe(themes[1].background);
		expect(violations.map((v) => v.id)).not.toContain("theme-paint-unchanged");
	});

	// The control behind every R5 verdict, driven BOTH ways — a control that cannot fail is the
	// thing it was built to refuse.
	test("the dark-theme control passes on a page that follows the OS", async ({ page }) => {
		await page.setContent(themed("#ffffff"));
		expect(await darkThemeControl(page)).toEqual([]);
	});

	test("the dark-theme control names a page that ignores the OS, and one that never repaints", async ({ page }) => {
		await page.setContent(themed("#4a4a4a", { follow: false }));
		const ignoresOs = await darkThemeControl(page);
		expect(ignoresOs.length, "the control fires").toBeGreaterThan(0);
		expect(ignoresOs.join(" "), "and says which theme, and what the page carried instead").toMatch(
			/dark theme.*never carried|never carried the `dark` class/,
		);

		await page.setContent(themed("#4a4a4a", { repaint: false }));
		const neverRepaints = await darkThemeControl(page);
		expect(
			neverRepaints.join(" "),
			"a class that toggles against a stylesheet that does not vary is still one paint measured twice",
		).toMatch(/same background/);
	});

	test("the report refuses the three ways an N/A goes wrong", () => {
		const { record } = createReport();
		expect(() => record({ route: "/x", url: "/x", predicate: "R1", verdict: "N/A" })).toThrow(/no reason/);
		expect(() =>
			record({ route: "/x", url: "/x", predicate: "R1", verdict: "N/A", reason: "it-was-hard" }),
		).toThrow(/not a declared N\/A reason/);
		expect(() =>
			record({ route: "/x", url: "/x", predicate: "R1", verdict: "PASS", reason: "redirect-only" }),
		).toThrow(/must not carry an N\/A reason/);
		// R5, R6 and R7 declare NO reason at all — they can never be escaped.
		expect(NA_REASONS.R5).toEqual([]);
		expect(NA_REASONS.R6).toEqual([]);
		expect(NA_REASONS.R7).toEqual([]);
		expect(() =>
			record({ route: "/x", url: "/x", predicate: "R5", verdict: "N/A", reason: "redirect-only" }),
		).toThrow(/never N\/A/);
	});
});
