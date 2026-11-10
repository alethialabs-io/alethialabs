// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PageToolbar's count pill is sized to its content, and PageToolbarSkeleton is the same row.
//
// F016 (#6117): the pill sat in a flex COLUMN, which stretches its children by default, so it grew
// to the width of the description beside it with the number in its far-left corner. jsdom does no
// layout, so this cannot measure a width. What it can read is the one class that decides it: the
// column's cross-axis alignment. Anything but `items-start` (or a `self-*`/`w-fit` on the pill
// itself) puts the stretch back.
//
// The skeleton half asserts the skeleton is built from the SAME row and column classes as the real
// toolbar, because that is the property that keeps the page from moving when data lands.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageToolbar, PageToolbarSkeleton } from "../src/page-toolbar";

/** The class list of the element with the given `data-slot` inside `root`, or throw. */
function slot(root: HTMLElement, name: string): HTMLElement {
	const el = root.querySelector(`[data-slot="${name}"]`);
	if (!(el instanceof HTMLElement)) throw new Error(`no [data-slot="${name}"]`);
	return el;
}

describe("PageToolbar count pill (F016)", () => {
	it("does not stretch the pill across the column", () => {
		const { container } = render(
			<PageToolbar count={42} description="A long line of supporting copy for the page." />,
		);
		const lead = slot(container, "page-toolbar-lead");
		const pill = slot(container, "count-pill");
		expect(pill.parentElement).toBe(lead);
		expect(lead.classList).toContain("flex-col");
		// The column's cross-axis alignment is what sizes the pill. `stretch` is the default.
		expect(lead.classList).toContain("items-start");
		expect(lead.classList).not.toContain("items-stretch");
		expect(pill.textContent).toBe("42");
	});

	it("still renders 0 as a count", () => {
		const { container } = render(<PageToolbar count={0} />);
		expect(slot(container, "count-pill").textContent).toBe("0");
	});
});

describe("PageToolbarSkeleton", () => {
	it("renders nothing when asked for nothing, like PageToolbar", () => {
		const { container } = render(<PageToolbarSkeleton description={false} />);
		expect(container.firstChild).toBeNull();
	});

	it("draws the same row and column as the real toolbar", () => {
		const real = render(
			<PageToolbar count={3} description="Copy" actions={<button type="button">Add</button>} />,
		).container;
		const skel = render(<PageToolbarSkeleton count actions={1} />).container;

		const realRow = slot(real, "page-toolbar");
		const skelRow = slot(skel, "page-toolbar-skeleton");
		expect(skelRow.className).toBe(realRow.className);
		expect(skelRow.getAttribute("aria-hidden")).toBe("true");

		const realLead = slot(real, "page-toolbar-lead");
		const skelLead = skelRow.firstElementChild;
		expect(skelLead?.className).toBe(realLead.className);

		const realActions = slot(real, "page-toolbar-actions");
		const skelActions = skelRow.lastElementChild;
		expect(skelActions?.className).toBe(realActions.className);
	});

	it("draws the count as a real, transparent CountPill and one placeholder per action", () => {
		const { container } = render(<PageToolbarSkeleton count actions={2} />);
		const pill = slot(container, "count-pill");
		expect(pill.classList).toContain("text-transparent");
		expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
	});

	it("carries the description's own type so the line is as tall as the copy", () => {
		const real = render(<PageToolbar description="Copy" />).container;
		const skel = render(<PageToolbarSkeleton />).container;
		const realP = slot(real, "page-toolbar-description");
		const skelP = skel.querySelector("p");
		// Every class but the ink, which the skeleton replaces with transparent text.
		const typeClasses = [...realP.classList].filter((c) => !c.startsWith("text-text-"));
		expect(typeClasses).toContain("text-ui-md");
		for (const c of typeClasses) expect(skelP?.classList).toContain(c);
		expect(skelP?.classList).toContain("text-transparent");
	});
});
