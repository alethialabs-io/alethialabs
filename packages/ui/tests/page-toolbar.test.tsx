// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PageToolbar has no count (LST-14, #7496), and PageToolbarSkeleton is the same row.
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

describe("PageToolbar", () => {
	it("renders no count pill, and keeps its column start-aligned (F016)", () => {
		const { container } = render(<PageToolbar description="A long line of supporting copy for the page." />);
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
		const lead = slot(container, "page-toolbar-lead");
		expect(lead.classList).toContain("flex-col");
		expect(lead.classList).toContain("items-start");
	});

	it("renders nothing when it has neither copy nor actions", () => {
		const { container } = render(<PageToolbar />);
		expect(container.firstChild).toBeNull();
	});
});

describe("PageToolbarSkeleton", () => {
	it("renders nothing when asked for nothing, like PageToolbar", () => {
		const { container } = render(<PageToolbarSkeleton description={false} />);
		expect(container.firstChild).toBeNull();
	});

	it("draws the same row and column as the real toolbar", () => {
		const real = render(
			<PageToolbar description="Copy" actions={<button type="button">Add</button>} />,
		).container;
		const skel = render(<PageToolbarSkeleton actions={1} />).container;

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

	it("draws one placeholder per action and no count", () => {
		const { container } = render(<PageToolbarSkeleton actions={2} />);
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
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
