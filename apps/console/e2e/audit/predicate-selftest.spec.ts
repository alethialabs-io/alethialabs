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
import { measurePage } from "./predicates";
import { createReport, NA_REASONS } from "./report";

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
	test("R1 — a page wider than the viewport is a FAIL, a page that fits is a PASS", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });

		await page.setContent(`<main style="margin:0"><div style="width: 2400px; height: 40px; background: #eee">wide</div></main>`);
		const bad = await measurePage(page, 1280);
		expect(bad.overflow.scrollWidth, "the fixture really does overflow").toBeGreaterThan(bad.overflow.clientWidth + 1);
		expect(bad.overflow.offenders.length, "R1 names what stuck out").toBeGreaterThan(0);

		await page.setContent(`<main style="margin:0"><div style="width: 100%; height: 40px">narrow</div></main>`);
		const good = await measurePage(page, 1280);
		expect(good.overflow.scrollWidth).toBeLessThanOrEqual(good.overflow.clientWidth + 1);
		expect(good.overflow.offenders).toEqual([]);
	});

	test("R3 — a second scroll container is a FAIL; one shell scroller is a PASS", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 400 });

		await page.setContent(`
			<main style="height: 300px; overflow-y: auto"><div style="height: 2000px">a</div></main>
			<aside style="height: 200px; overflow-y: auto"><div style="height: 2000px">b</div></aside>`);
		const two = await measurePage(page, 1280);
		expect(two.scrollContainers.length, "two containers really are scrolling").toBeGreaterThan(1);

		await page.setContent(`<main style="height: 300px; overflow-y: auto"><div style="height: 2000px">a</div></main>`);
		const one = await measurePage(page, 1280);
		expect(one.scrollContainers).toHaveLength(1);
		expect(one.scrollContainers[0].isShellScroller, "the one scroller is the shell's <main>").toBe(true);

		// And a container DECLARED scrollable whose content fits is not a scroll container.
		await page.setContent(`<main style="height: 300px; overflow-y: auto"><div style="height: 10px">a</div></main>`);
		expect((await measurePage(page, 1280)).scrollContainers).toEqual([]);

		// THE DOCUMENT SCROLLING IS **ONE** CONTAINER, not two. `querySelectorAll("*")` already
		// contains `<html>`, so an explicit `[documentElement, ...all]` visited it twice and every
		// page whose document scrolls reported two identical containers and failed R3 for having
		// "two" — naming the same element both times. No earlier fixture made the document
		// overflow, which is exactly why nothing caught it.
		await page.setContent(`<div style="height: 4000px">tall</div>`);
		const doc = await measurePage(page, 1280);
		expect(doc.scrollContainers).toHaveLength(1);
		expect(doc.scrollContainers[0].isShellScroller, "the document IS the shell scroller here").toBe(true);
	});

	test("R4 — two overlapping buttons are a FAIL; a nested pair and a disjoint pair are not", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });

		await page.setContent(`
			<main style="position: relative; height: 400px">
				<button style="position: absolute; left: 40px; top: 40px; width: 120px; height: 40px">one</button>
				<button style="position: absolute; left: 100px; top: 60px; width: 120px; height: 40px">two</button>
			</main>`);
		const overlapping = await measurePage(page, 1280);
		expect(overlapping.overlaps.length, "the overlap is reported").toBe(1);
		expect(overlapping.overlaps[0].overlapWidth).toBeGreaterThan(2);

		await page.setContent(`
			<main style="position: relative; height: 400px">
				<a href="#" style="position: absolute; left: 40px; top: 40px; width: 200px; height: 80px">
					<button style="width: 60px; height: 30px">nested</button>
				</a>
				<button style="position: absolute; left: 400px; top: 40px; width: 120px; height: 40px">far</button>
			</main>`);
		expect((await measurePage(page, 1280)).overlaps, "nesting is not overlapping").toEqual([]);
	});

	test("T5 — a hand-rolled empty state is a FAIL; @repo/ui/empty is a PASS", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });

		await page.setContent(`
			<main><div style="text-align: center; padding: 40px">No clusters yet. Deploy one to get started.</div></main>`);
		const rolled = await measurePage(page, 1280);
		expect(rolled.empty.shared).toBe(0);
		expect(rolled.empty.handRolled.length, "the hand-rolled empty region is named").toBeGreaterThan(0);

		await page.setContent(`
			<main><div data-slot="empty" style="text-align: center; padding: 40px">No clusters yet.</div></main>`);
		const shared = await measurePage(page, 1280);
		expect(shared.empty.shared).toBe(1);
		expect(shared.empty.handRolled, "content inside the shared component is not a finding").toEqual([]);
	});

	test("R2 — the hit test catches an overlay that a z-index matcher reads as correct", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });

		// THE SHIPPED SHAPE (packages/ui/src/popover.tsx): the popup names `z-index: 50` but is
		// `position: static`, on which z-index is a no-op — so the later positioned sibling paints
		// over it. Every class-name check passes. The hit test does not.
		await page.setContent(`
			<main style="position: relative; height: 600px">
				<div style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px">
					<div data-slot="popover-content" style="z-index: 50; background: white; border: 1px solid #ccc; height: 200px">
						popover body
					</div>
				</div>
				<div style="position: absolute; left: 60px; top: 60px; width: 500px; height: 400px; background: rgba(255,0,0,.4)">
					a later positioned sibling
				</div>
			</main>`);
		const behind = await hitTestSlot(page, "popover-content");
		expect(behind, "the fixture overlay is measurable").not.toBe("off-screen");
		if (behind === "off-screen") return;
		expect(
			behind.points.filter((p) => !p.inside).length,
			`every probed point should have landed OUTSIDE the popover: ${JSON.stringify(behind.points)}`,
		).toBe(behind.points.length);

		// The fix that repo comment records is a `position: relative` — nothing a z-index matcher
		// looks at. With it, the same markup and the same z-index hit-test clean.
		await page.setContent(`
			<main style="position: relative; height: 600px">
				<div style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px">
					<div data-slot="popover-content" style="position: relative; z-index: 50; background: white; border: 1px solid #ccc; height: 200px">
						popover body
					</div>
				</div>
				<div style="position: absolute; left: 60px; top: 60px; width: 500px; height: 400px; background: rgba(255,0,0,.4)">
					a later positioned sibling
				</div>
			</main>`);
		const above = await hitTestSlot(page, "popover-content");
		expect(above).not.toBe("off-screen");
		if (above === "off-screen") return;
		expect(above.points.filter((p) => !p.inside), "the fixed overlay is on top at every probe").toEqual([]);
	});

	test("R2 — an overlay under fixed chrome is caught at the corners, not only the centre", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		// The overlay's centre is clear; only its top edge is under the chrome. A centre-only hit
		// test would call this clean, which is why the rubric names the four inset corners.
		await page.setContent(`
			${CHROME}
			<main style="position: relative; height: 600px">
				<div data-slot="dialog-content" style="position: absolute; left: 200px; top: 20px; width: 400px; height: 300px; z-index: 10; background: white; border: 1px solid #ccc">
					dialog body
				</div>
			</main>`);
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
		await page.setContent(`
			<main style="position: relative; height: 600px">
				<div data-slot="tooltip-content" style="position: absolute; left: 200px; top: 200px; width: 200px; height: 80px; z-index: 10; pointer-events: none; background: #222; color: white">tip</div>
			</main>`);
		const measured = await hitTestSlot(page, "tooltip-content");
		expect(measured).not.toBe("off-screen");
		if (measured === "off-screen") return;
		expect(measured.pointerEventsRelaxed, "the probe records that it had to relax pointer-events").toBe(true);
		expect(measured.points.filter((p) => !p.inside), "and then reads the real stacking").toEqual([]);
	});

	test("T6 — the ErrorState signature is derived from source, and distinguishes a look-alike", async ({ page }) => {
		const arms = errorStateSignature();
		expect(arms.length, "at least one layout arm was read out of error-state.tsx").toBeGreaterThan(0);

		await page.setContent(`<main><div class="${arms[0].join(" ")}"><h1>Couldn't load this page</h1></div></main>`);
		expect(await rendersSharedErrorState(page), "the real component's class set is recognised").toBe(true);

		await page.setContent(`<main><div class="flex items-center justify-center"><h1>Couldn't load this page</h1></div></main>`);
		expect(
			await rendersSharedErrorState(page),
			"a hand-rolled error panel with the same COPY is not the shared component",
		).toBe(false);
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
