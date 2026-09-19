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
import { CONTROL_FIXTURE as FILTERS_FIXTURE, filtersControl } from "./filters";
import { CONTROL_FIXTURE, emptinessProblems, endsTheSession, enumerateControls, interactionControl, isSameOrigin, namesDestructiveAction, preActivationExclusion } from "./inert";
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

	// ── R8: every enabled control does something (#4277) ──────────────────────────────────────
	//
	// The control `inert.spec.ts` CONSULTS, driven here in both directions. It is not enough that it
	// passes on a good page: a control that cannot fail is the thing it was built to refuse, and
	// #3804 is the incident where a green-looking instrument published FAILs for real routes. So
	// each arm is neutered in turn and the control must NAME the arm that stopped firing.

	test("R8 — the interaction control passes on a page whose answers are known", async ({ page }) => {
		expect(await interactionControl(page), "every arm answers on the control's own fixture").toEqual([]);
	});

	test("R8 — the control names the FAIL arm when a handler-less button stops reading as inert", async ({ page }) => {
		// The mutant gives the inert button a handler that mutates `main`. If the instrument still
		// reports it inert-free, then nothing in the console can ever be reported inert.
		const mutant = CONTROL_FIXTURE.replace(
			'document.getElementById("opener").addEventListener',
			'document.getElementById("inert").addEventListener("click", function () { document.querySelector("main").appendChild(document.createTextNode("x")); });\n\tdocument.getElementById("opener").addEventListener',
		);
		const problems = await interactionControl(page, mutant);
		expect(problems.join(" "), "the control says the FAIL arm stopped firing").toMatch(/handler-less button reported/);
	});

	test("R8 — the control names the PASS arm when the dialog opener opens nothing", async ({ page }) => {
		const mutant = CONTROL_FIXTURE.replace('d.setAttribute("role", "dialog");', "");
		const problems = await interactionControl(page, mutant);
		expect(problems.join(" "), "the control says the PASS arm stopped firing").toMatch(/dialog opener reported/);
	});

	test("R8 — the control names the enumeration when a disabled control starts being scored", async ({ page }) => {
		const mutant = CONTROL_FIXTURE.replace('aria-disabled="true" ', "");
		const problems = await interactionControl(page, mutant);
		expect(problems.join(" "), "an aria-disabled control must not be enumerated as enabled").toMatch(
			/was not counted as `disabled-with-reason`|enumerated as enabled/,
		);
	});

	test("R8 — a disabled control is COUNTED, with or without a reason, and never scored", async ({ page }) => {
		await page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body><main>
			<button disabled title="Ask an owner">With a reason</button>
			<button aria-disabled="true">With none</button>
			<button>Enabled</button>
		</main></body></html>`);
		const found = await enumerateControls(page, "main", "main");
		expect(found.controls.map((c) => c.name), "only the enabled control is scored").toEqual(["Enabled"]);
		expect(found.disabled.map((d) => d.reason).sort(), "and both disabled ones are counted, split by whether they say why").toEqual([
			"disabled-no-reason",
			"disabled-with-reason",
		]);
	});

	test("R8 — an external link PASSES on its href and is never enumerated for a click", async ({ page }) => {
		// Served from a real origin, NOT `setContent`. `setContent` leaves the page at `about:blank`,
		// which is an opaque origin: an absolute-path href such as `/[org]/settings` throws when
		// resolved against it, `isSameOrigin` answers false, and the link reads as external. (`#`
		// does resolve — to `about:blank#`, whose origin is `null` like the page's — so it stays.) That
		// measures the fixture's URL, not the predicate — which is correct at the origin the audit
		// actually runs on. The route is torn down with the page, and nothing leaves the browser.
		const body = `<!doctype html><html lang="en"><head><title>t</title></head><body><main>
			<a href="https://docs.example.invalid/x">Docs</a>
			<a href="/[org]/settings">Settings</a>
			<a href="#">Nowhere</a>
		</main></body></html>`;
		await page.route("http://app.test/**", (route) => route.fulfill({ contentType: "text/html", body }));
		await page.goto("http://app.test/org");
		const found = await enumerateControls(page, "main", "main");
		expect(found.external.map((e) => e.name), "the cross-origin link is external").toEqual(["Docs"]);
		// A same-origin `href="#"` STAYS in `controls`: that is exactly the inert control R8 hunts,
		// and only a click can say whether a handler does the work the href does not.
		expect(found.controls.map((c) => c.name).sort()).toEqual(["Nowhere", "Settings"]);
	});

	test("R8 — a scope that is itself a LIST enumerates every part of it", async ({ page }) => {
		// The shell chrome's scope is `header, aside`. Interpolating it naively yields
		// `header, aside button`, which CSS reads as "every <header>, or every button inside an
		// <aside>" — the header's own buttons vanish and the <header> element is enumerated as a
		// control. The chrome pass would then have measured one unnamed thing and looked like it
		// worked, which is why this is asserted rather than left to the selector's shape.
		await page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body>
			<header><button>In the header</button></header>
			<aside><button>In the sidebar</button></aside>
			<main><button>In main</button></main>
		</body></html>`);
		const chrome = await enumerateControls(page, "header, aside", "chrome");
		expect(chrome.controls.map((c) => c.name).sort(), "both halves of the scope, and nothing from main").toEqual([
			"In the header",
			"In the sidebar",
		]);
	});

	test("R8 — the destructive-name matcher reads a verb with an object, and not a dialog's way out", () => {
		// The census matches IDENTIFIERS (`cancelSubscription`) and requires a capital after the
		// verb; a NAME has no such shape. A bare "Cancel" is every form's escape hatch and must not
		// file a finding against every form in the console — but a bare "Delete" IS a real
		// destructive control, because `SettingsDangerRow` labels every one of them exactly that.
		expect(namesDestructiveAction("Delete"), "the shipped bare shape").toBe(true);
		expect(namesDestructiveAction("Delete workspace")).toBe(true);
		expect(namesDestructiveAction("Revoke API key")).toBe(true);
		expect(namesDestructiveAction("Cancel"), "a bare Cancel is a way out, not a destruction").toBe(false);
		expect(namesDestructiveAction("Cancel subscription"), "with an object it is one").toBe(true);
		expect(namesDestructiveAction("Undelete"), "word-anchored at the front").toBe(false);
		expect(namesDestructiveAction("Cancellation policy")).toBe(false);
		expect(namesDestructiveAction("Open project")).toBe(false);
	});

	test("R8 — an UNDECLARED destructive name is tagged and never activated; a declared one is activated", () => {
		// The fourth arm of the positive control, driven in both directions because each direction
		// fails differently and neither is loud on its own. Stuck at "not registered", R8 files a
		// FAIL against all 40 of the ledger's own confirmed buttons — a blind counter manufacturing
		// work. Stuck at "registered", a delete nobody declared gets CLICKED, which is the one thing
		// this predicate promises never to do. The route loop and the menu loop both ask this
		// function, so the property holds for a menu item — where most of the console's deletes
		// live — and not only for a button in `main`.
		expect(preActivationExclusion("Delete workspace", false)).toBe("unregistered-destructive");
		expect(preActivationExclusion("Delete workspace", true), "its declared confirmation IS its effect").toBeNull();
		expect(preActivationExclusion("Delete", false), "the bare shape `SettingsDangerRow` ships").toBe("unregistered-destructive");
		expect(preActivationExclusion("Cancel", false), "every form's way out is not a destruction").toBeNull();
		expect(preActivationExclusion("Open project", false), "an exclusion that fires on an ordinary button measures nothing").toBeNull();
		// Sign-out wins over the ledger: being declared does not make it safe to revoke the run's
		// own session.
		expect(preActivationExclusion("Sign out", true)).toBe("session-ending");
	});

	test("R8 — the interaction control NAMES the tag arm when the ledger join stops discriminating", async ({ page }) => {
		// A join that answers the same way for everything passes every arm that only asks it once.
		// `interactionControl()` asks it both ways, so the control is red under either stuck answer
		// — and `inert.spec.ts` withholds R8 for the whole run rather than publishing the column.
		expect(await interactionControl(page), "the shipped join discriminates").toEqual([]);
		expect(
			preActivationExclusion("Delete workspace", false) === preActivationExclusion("Delete workspace", true),
			"a ledger join whose two answers agree is not a join",
		).toBe(false);
	});

	test("R8 — same-origin is measured against the PAGE, not a hardcoded production host", () => {
		// A constant base would read `https://alethialabs.io/pricing` as internal and CLICK it,
		// navigating the run off the app it is measuring.
		expect(isSameOrigin("/org/settings", "http://localhost:3000/org")).toBe(true);
		expect(isSameOrigin("https://alethialabs.io/pricing", "http://localhost:3000/org")).toBe(false);
		expect(isSameOrigin("http://localhost:3000/x", "http://localhost:3000/org")).toBe(true);
		expect(isSameOrigin("mailto:support@example.invalid", "http://localhost:3000/org")).toBe(false);
	});

	test("R8 — the one control it may not press is the one that ends the run's own session", () => {
		expect(endsTheSession("Sign out")).toBe(true);
		expect(endsTheSession("Log out")).toBe(true);
		expect(endsTheSession("Signout")).toBe(true);
		expect(endsTheSession("Sign out of every device"), "one pattern, spelled out — not a prefix match").toBe(false);
		expect(endsTheSession("Sign in")).toBe(false);
	});

	test("R8 — notMeasured() is a claim about the RUN, and an N/A is a claim about the PAGE", () => {
		// The two must not share a column. An N/A counts as "asked, and does not apply"; a predicate
		// escaped into it scores higher with nothing red anywhere, which is the rubric's own warning.
		const report = createReport();
		const withheld = report.notMeasured({
			route: "/x",
			url: "/x",
			predicate: "R8",
			reason: "control-budget-exceeded (140 enabled controls, budget 60)",
		});
		expect(withheld.verdict).toBe("NOT MEASURED");
		expect(withheld.reason).toContain("budget");
		expect(() => report.notMeasured({ route: "/y", url: "/y", predicate: "R8", reason: "   " })).toThrow(/no reason/);

		// R8's two declared N/A reasons, and nothing else.
		expect(NA_REASONS.R8).toEqual(["redirect-only", "no-enabled-controls"]);
		expect(() =>
			createReport().record({ route: "/x", url: "/x", predicate: "R8", verdict: "N/A", reason: "too-many-controls" }),
		).toThrow(/not a declared N\/A reason/);

		// A run-scoped withhold still WINS over a cell-scoped reason: if the predicate's own control
		// is red, the reason this caller computed was computed by the broken instrument too.
		const red = createReport();
		red.withhold(["R8"], "positive control failed: the dialog opener reported null");
		const overridden = red.notMeasured({ route: "/x", url: "/x", predicate: "R8", reason: "control-budget-exceeded" });
		expect(overridden.verdict).toBe("NOT MEASURED");
		expect(overridden.reason, "the instrument's failure is the reason, not the cell's").toContain("positive control failed");

		// And a column of NOT MEASURED scores `null`, never 1.
		expect(red.summarise().R8).toEqual({ pass: 0, fail: 0, na: 0, notMeasured: 1, score: null });
	});

	test("R8 — a full column of NOT MEASURED is not a clean board, and a WITHHELD one is not either", () => {
		const forty = (verdict: string) => Array.from({ length: 40 }, (_, i) => ({ route: `/r${i}`, verdict }));

		// The shape that reads green to any check that only counts records: forty cells, none
		// missing, and not one of them a measurement.
		expect(emptinessProblems(forty("NOT MEASURED"), undefined, 40, 1).join(" "), "forty NOT MEASURED is not a pass").toMatch(/produced a PASS or a FAIL/);

		// And the nastier one: the instrument's own control was red, so every cell was REWRITTEN to
		// NOT MEASURED by `withhold()`. The record count is perfect and the verdicts are uniform —
		// an emptiness check that does not ask about the withhold cannot see this at all.
		const withheldRun = emptinessProblems(forty("NOT MEASURED"), "the dialog opener reported null", 40, 1);
		expect(withheldRun.join(" ")).toMatch(/positive control was red/);

		// A route recorded NOWHERE shrinks the denominator to fit the answer.
		expect(emptinessProblems([...forty("PASS").slice(0, 39)], undefined, 40, 1).join(" ")).toMatch(/39 of 40 routes/);

		// N/A is a claim about the PAGE and leaves the denominator, but it is not a measurement: a
		// board of nothing but N/A still has to clear the floor.
		expect(emptinessProblems(forty("N/A"), undefined, 40, 1).join(" ")).toMatch(/produced a PASS or a FAIL/);

		// The only shape that passes: every route accounted for, the control green, and something
		// actually driven.
		expect(emptinessProblems([...forty("NOT MEASURED").slice(0, 39), { route: "/r39", verdict: "PASS" }], undefined, 40, 1)).toEqual([]);
	});

	// ── F8–F10: the filter standard, observed (#4278) ─────────────────────────────────────────
	//
	// The control `filters.spec.ts` CONSULTS, driven here in both directions. `filtersControl()`
	// already asks every arm both ways — the good bar must PASS, each bad bar must FAIL the one
	// predicate it breaks — so what these add is the proof that each arm can go RED: neuter the defect
	// a bad bar carries and the control must NAME that arm, or an instrument that cannot fail would
	// read as working.

	test("F8–F10 — the filters control passes on bars whose answers are known", async ({ page }) => {
		// Five fixture bars end to end: ~60 s on a laptop, over this project's 180 s on a slow runner.
		test.setTimeout(300_000);
		expect(await filtersControl(page), "every arm answers on the control's own fixtures").toEqual([]);
	});

	test("F8 — the control names the arm when the URL-less bar starts writing the URL", async ({ page }) => {
		test.setTimeout(300_000);
		const mutant = FILTERS_FIXTURE.replace('if (MODE === "no-url") return;', "");
		expect(mutant, "the mutation must apply").not.toBe(FILTERS_FIXTURE);
		expect((await filtersControl(page, mutant)).join(" ")).toMatch(/never writes the URL reported F8 PASS/);
	});

	test("F9 — the control names the arm when the moving-counts bar holds its counts still", async ({ page }) => {
		test.setTimeout(300_000);
		const mutant = FILTERS_FIXTURE.replace('var universe = MODE === "moving-counts" || MODE === "one-kind"', 'var universe = MODE === "one-kind"');
		expect(mutant, "the mutation must apply").not.toBe(FILTERS_FIXTURE);
		expect((await filtersControl(page, mutant)).join(" ")).toMatch(/counts move reported F9 PASS/);
	});

	test("F10 — the control names the arm when the per-keystroke bar starts debouncing", async ({ page }) => {
		test.setTimeout(300_000);
		const mutant = FILTERS_FIXTURE.replace('if (MODE === "per-keystroke") {', 'if (MODE === "never") {');
		expect(mutant, "the mutation must apply").not.toBe(FILTERS_FIXTURE);
		expect((await filtersControl(page, mutant)).join(" ")).toMatch(/fetches per keystroke reported F10 PASS/);
	});

	test("F8–F9 — the control names the arm when the one-kind bar gains an option that narrows", async ({ page }) => {
		test.setTimeout(300_000);
		// Give the one-kind bar a second kind: an option now narrows, the in-memory counts move, and the
		// arm that must be NOT MEASURED is measured instead — so the arm can go red, and would have caught
		// the vacuous PASS the fallback target used to score on it.
		const mutant = FILTERS_FIXTURE.replace('ROWS = [{ name: "alpha", kind: "a" }, { name: "beta", kind: "a" }', 'ROWS = [{ name: "alpha", kind: "a" }, { name: "beta", kind: "b" }');
		expect(mutant, "the mutation must apply").not.toBe(FILTERS_FIXTURE);
		expect((await filtersControl(page, mutant)).join(" ")).toMatch(/facet cannot narrow reported F9 FAIL/);
	});

	test("F8–F10 — N/A is structural: `not-a-list-page` everywhere, `no-search-field` on F10 only", () => {
		expect(NA_REASONS.F8).toEqual(["not-a-list-page"]);
		expect(NA_REASONS.F9).toEqual(["not-a-list-page"]);
		expect(NA_REASONS.F10).toEqual(["not-a-list-page", "no-search-field"]);
		// "the list had one row" is a claim about the RUN — NOT MEASURED, never an N/A.
		expect(() => createReport().record({ route: "/x", url: "/x", predicate: "F8", verdict: "N/A", reason: "too-few-rows" })).toThrow(/not a declared N\/A reason/);
		expect(() => createReport().record({ route: "/x", url: "/x", predicate: "F8", verdict: "N/A", reason: "no-search-field" })).toThrow(/not a declared N\/A reason/);
		expect(createReport().notMeasured({ route: "/x", url: "/x", predicate: "F9", reason: "the list rendered 1 row(s)" }).verdict).toBe("NOT MEASURED");
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
