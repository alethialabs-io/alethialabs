// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rendered predicates R1, R3, R4 and T5, measured in the page.
//
// Every measurement NAMES what it found rather than answering yes/no. The reason is the failure
// branch: "R4 failed" sends the next reader to open 40 pages by hand; "R4: button.Deploy @312,180
// 96x32 overlaps a[href=…] @330,190 120x28 by 78x18" sends them to one line of one component.
//
// One `page.evaluate` does all four, for two reasons. It is one round trip per viewport rather than
// four, and — load-bearing — the describe/visible helpers are declared INSIDE the evaluated
// function. They cannot be shared via a closure (evaluate serializes the function it is given) and
// they must not be shared via `new Function(...)`: that is `eval`, and it is subject to the page's
// own Content-Security-Policy, so the whole measurement would start throwing the day the console
// tightens `script-src` — a live audit that fails for a reason that has nothing to do with the
// pages it audits.

import type { Page } from "@playwright/test";

/** The viewport widths R1 is measured at, from the rubric. Height is fixed so R3 is comparable. */
export const R1_WIDTHS = [768, 1280, 1440, 1920] as const;
export const AUDIT_VIEWPORT_HEIGHT = 900;

export interface OverflowMeasurement {
	scrollWidth: number;
	clientWidth: number;
	/** The widest elements sticking out past the viewport — the diagnostic, not the verdict. */
	offenders: { description: string; right: number; width: number }[];
}

export interface ScrollContainer {
	description: string;
	/** True when the element is the shell's own scroll region (`<main>`), or the document itself. */
	isShellScroller: boolean;
	scrollHeight: number;
	clientHeight: number;
	overflowY: string;
}

export interface OverlapPair {
	a: string;
	b: string;
	overlapWidth: number;
	overlapHeight: number;
}

export interface EmptyStateMeasurement {
	/** Visible `@repo/ui/empty` regions in the content area. */
	shared: number;
	/** Regions that READ as an empty state but are not `@repo/ui/empty`. */
	handRolled: { description: string; text: string }[];
	/** Rows/items found in the content area — a populated list cannot answer T5. */
	items: number;
}

/** Everything the rendered predicates need from one viewport, in one round trip. */
export interface PageMeasurement {
	width: number;
	overflow: OverflowMeasurement;
	scrollContainers: ScrollContainer[];
	overlaps: OverlapPair[];
	empty: EmptyStateMeasurement;
}

/**
 * Measure R1, R3, R4 and T5 against the page as it currently stands.
 *
 * The caller sets the viewport and settles the page first; this reads, it does not wait.
 */
export async function measurePage(page: Page, width: number): Promise<PageMeasurement> {
	const measured = await page.evaluate(() => {
		const describe = (el: Element): string => {
			const id = el.id ? `#${el.id}` : "";
			const slotAttr = el.getAttribute("data-slot");
			const slot = slotAttr ? `[data-slot=${slotAttr}]` : "";
			const cls =
				typeof el.className === "string" && el.className.trim()
					? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
					: "";
			const label = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
			const r = el.getBoundingClientRect();
			return (
				el.tagName.toLowerCase() +
				id +
				slot +
				cls +
				(label ? `[aria-label="${label}"]` : "") +
				(text ? ` "${text}"` : "") +
				` @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
			);
		};
		const visible = (el: Element): boolean => {
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return false;
			const s = getComputedStyle(el);
			if (s.visibility === "hidden" || s.display === "none") return false;
			return Number(s.opacity) >= 0.05;
		};

		const all = Array.from(document.querySelectorAll("*"));

		// ── R1: what sticks out past the viewport's right edge. A negative-left element (an
		// off-canvas drawer parked at -100%) does not widen the document and is not an offender.
		const clientWidth = document.body.clientWidth;
		const offenders: { description: string; right: number; width: number }[] = [];
		for (const el of all) {
			if (!visible(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.right > clientWidth + 1) {
				offenders.push({ description: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
			}
		}
		offenders.sort((a, b) => b.right - a.right);

		// ── R3: elements ACTUALLY scrolling. A container declared `overflow-y-auto` whose content
		// fits is a declaration, not a scroll container.
		const scrollingEl = document.scrollingElement;
		const scrollContainers: ScrollContainer[] = [];
		for (const el of [document.documentElement, ...all]) {
			const s = getComputedStyle(el);
			const scrolls =
				el === document.documentElement || s.overflowY === "auto" || s.overflowY === "scroll";
			if (!scrolls) continue;
			if (el !== document.documentElement && !visible(el)) continue;
			if (el.scrollHeight <= el.clientHeight + 1) continue;
			scrollContainers.push({
				description: describe(el),
				isShellScroller: el.tagName.toLowerCase() === "main" || el === scrollingEl,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				overflowY: s.overflowY,
			});
		}

		// ── R4: interactive boxes that intersect. Excluded, with reasons, because each would
		// otherwise be a false FAIL that teaches people to ignore the predicate:
		//  · a pair where one CONTAINS the other — a button inside a link is a nesting question,
		//    which axe (R5) already owns;
		//  · anything inside an open overlay — an overlay is SUPPOSED to sit over the page (R2);
		//  · boxes under 8x8 or effectively invisible (`sr-only` is a 1px clipped box);
		//  · `pointer-events: none`, which cannot take a click and so cannot steal one.
		// 2px of intersection in EACH axis is required, so sub-pixel layout rounding is not a find.
		const INTERACTIVE =
			'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
			'[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], ' +
			'[role="checkbox"], [tabindex]:not([tabindex="-1"])';
		const OVERLAY =
			'[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], ' +
			'[data-slot="popover-content"], [data-slot="dropdown-menu-content"], ' +
			'[data-slot="dropdown-menu-sub-content"], [data-slot="tooltip-content"], ' +
			'[data-slot="hover-card-content"], [data-slot="select-content"]';
		const candidates = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => {
			if (!visible(el)) return false;
			if (el.closest(OVERLAY)) return false;
			if (el.hasAttribute("disabled")) return false;
			if (getComputedStyle(el).pointerEvents === "none") return false;
			const r = el.getBoundingClientRect();
			return r.width >= 8 && r.height >= 8;
		});
		const overlaps: OverlapPair[] = [];
		outer: for (let i = 0; i < candidates.length; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				const a = candidates[i];
				const b = candidates[j];
				if (a.contains(b) || b.contains(a)) continue;
				const ra = a.getBoundingClientRect();
				const rb = b.getBoundingClientRect();
				const ow = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
				const oh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
				if (ow <= 2 || oh <= 2) continue;
				overlaps.push({
					a: describe(a),
					b: describe(b),
					overlapWidth: Math.round(ow),
					overlapHeight: Math.round(oh),
				});
				if (overlaps.length >= 12) break outer;
			}
		}

		// ── T5: how the page renders its empty regions (driven against an EMPTY org).
		//
		// KNOWN LIMIT, stated rather than hidden: the hand-rolled arm is a SHAPE plus a phrasing
		// test — a centred, item-less block whose text reads like an empty state. A hand-rolled
		// empty state phrased outside that shape reads as N/A, not FAIL. That is exactly why the
		// rubric makes the per-predicate N/A count a first-class column: a growing T5 N/A count is
		// this limit being hit, and it is visible without anyone auditing for it.
		const root: Element = document.querySelector("main") ?? document.body;
		const sharedEmpty = Array.from(root.querySelectorAll('[data-slot="empty"]')).filter(visible).length;
		const items = Array.from(
			root.querySelectorAll('tbody tr, [role="row"], li[data-slot], [data-slot="card"]'),
		).filter(visible).length;
		const EMPTY_COPY =
			/\b(no|none|nothing|zero)\b[\s\S]{0,80}?\b(yet|found|to show|to display|here|available|created|configured|connected|match)\b|\byou (haven'?t|have not)\b/i;
		const handRolled: { description: string; text: string }[] = [];
		for (const el of Array.from(root.querySelectorAll("div, section, p"))) {
			if (!visible(el)) continue;
			if (el.closest('[data-slot="empty"]')) continue;
			const s = getComputedStyle(el);
			const centred =
				s.textAlign === "center" ||
				(s.display.includes("flex") && s.alignItems === "center" && s.justifyContent === "center");
			if (!centred) continue;
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
			if (text.length < 8 || text.length > 240) continue;
			if (!EMPTY_COPY.test(text)) continue;
			// Only the OUTERMOST match: a centred block's centred children would each report.
			if (handRolled.some((h) => h.text.includes(text.slice(0, 120)))) continue;
			handRolled.push({ description: describe(el), text: text.slice(0, 120) });
		}

		return {
			overflow: { scrollWidth: document.body.scrollWidth, clientWidth, offenders: offenders.slice(0, 6) },
			scrollContainers,
			overlaps,
			empty: { shared: sharedEmpty, handRolled: handRolled.slice(0, 4), items },
		};
	});
	return { width, ...measured };
}
