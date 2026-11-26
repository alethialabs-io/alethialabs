// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ListToolbar owns the list page's filter row (#7734): it renders the pieces it is given in ONE
// order, pushes the page's controls to the far right, and its skeleton is the same row.
//
// jsdom does no layout, so nothing here measures a position. What it can read is DOM order, which
// is reading and tab order, and the classes that decide wrapping and right-alignment.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ListToolbar, ListToolbarSkeleton } from "../src/list-toolbar";

const OPTIONS = [
	{ value: "online", label: "Online" },
	{ value: "offline", label: "Offline" },
];

/** The element with the given `data-slot` inside `root`, or throw. */
function slot(root: HTMLElement, name: string): HTMLElement {
	const el = root.querySelector(`[data-slot="${name}"]`);
	if (!(el instanceof HTMLElement)) throw new Error(`no [data-slot="${name}"]`);
	return el;
}

/** Whether `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
	return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("ListToolbar", () => {
	it("renders search, facets, range, extra, reset, then view and actions, in that order", () => {
		render(
			<ListToolbar
				search={{ value: "", onChange: () => {}, placeholder: "Search runners" }}
				facets={[
					{ label: "Status", options: OPTIONS, value: [], onChange: () => {} },
					{ label: "Region", options: OPTIONS, value: [], onChange: () => {} },
				]}
				dateRange={<button type="button">Last 7 days</button>}
				extra={<button type="button">More</button>}
				reset={{ count: 2, onReset: () => {} }}
				view={<button type="button">Grid</button>}
				actions={<button type="button">Add runner</button>}
			/>,
		);
		const order = [
			screen.getByRole("textbox", { name: "Search runners" }),
			screen.getByRole("button", { name: /Status/ }),
			screen.getByRole("button", { name: /Region/ }),
			screen.getByRole("button", { name: "Last 7 days" }),
			screen.getByRole("button", { name: "More" }),
			screen.getByRole("button", { name: /Reset · 2/i }),
			screen.getByRole("button", { name: "Grid" }),
			screen.getByRole("button", { name: "Add runner" }),
		];
		for (let i = 1; i < order.length; i++) expect(precedes(order[i - 1], order[i])).toBe(true);
	});

	it("pushes view and actions right, and wraps the row", () => {
		const { container } = render(
			<ListToolbar
				search={{ value: "", onChange: () => {}, placeholder: "Search" }}
				view={<button type="button">Grid</button>}
				actions={<button type="button">Add</button>}
			/>,
		);
		const end = slot(container, "list-toolbar-end");
		expect(end.classList).toContain("ml-auto");
		expect(screen.getByRole("button", { name: "Grid" }).parentElement).toBe(end);
		expect(screen.getByRole("button", { name: "Add" }).parentElement).toBe(end);
		const row = end.parentElement;
		expect(row?.classList).toContain("flex-wrap");
	});

	it("passes search input through and the facet's own props to FacetFilter", async () => {
		const user = userEvent.setup();
		const onSearch = vi.fn();
		const onStatus = vi.fn();
		render(
			<ListToolbar
				search={{ value: "", onChange: onSearch, placeholder: "Search", ariaLabel: "Search jobs" }}
				facets={[{ label: "Status", options: OPTIONS, value: ["online"], onChange: onStatus }]}
			/>,
		);
		await user.type(screen.getByRole("textbox", { name: "Search jobs" }), "a");
		expect(onSearch).toHaveBeenCalledWith("a");
		// The selected count badge is FacetFilter's own render, so the value reached it.
		expect(screen.getByRole("button", { name: /Status/ }).textContent).toContain("1");
	});

	it("hides Reset at zero and fires onReset when shown", async () => {
		const user = userEvent.setup();
		const onReset = vi.fn();
		const { rerender } = render(
			<ListToolbar
				search={{ value: "", onChange: () => {} }}
				reset={{ count: 0, onReset }}
			/>,
		);
		expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
		rerender(<ListToolbar search={{ value: "", onChange: () => {} }} reset={{ count: 1, onReset }} />);
		await user.click(screen.getByRole("button", { name: /Reset · 1/i }));
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it("omits the right-aligned group when there is nothing to put in it", () => {
		const { container } = render(<ListToolbar search={{ value: "", onChange: () => {} }} />);
		expect(container.querySelector('[data-slot="list-toolbar-end"]')).toBeNull();
	});

	it("renders nothing when given nothing", () => {
		const { container } = render(<ListToolbar facets={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ListToolbarSkeleton", () => {
	it("is the same row as the real toolbar", () => {
		const real = render(
			<ListToolbar
				search={{ value: "", onChange: () => {} }}
				actions={<button type="button">Add</button>}
			/>,
		);
		const realEnd = slot(real.container, "list-toolbar-end");
		const realRow = realEnd.parentElement;
		const realClasses = realRow ? [...realRow.classList].sort() : [];
		const realEndClasses = [...realEnd.classList].sort();
		const realSearch = screen.getByRole("textbox").parentElement;
		const realSearchClasses = realSearch ? [...realSearch.classList] : [];
		real.unmount();

		const { container } = render(<ListToolbarSkeleton facets={2} actions={1} />);
		const row = slot(container, "list-toolbar-skeleton");
		expect(row.getAttribute("aria-hidden")).toBe("true");
		expect([...row.classList].sort()).toEqual(realClasses);
		const search = row.querySelector('[data-part="search"]');
		// The search placeholder carries the real search's width classes.
		for (const c of ["w-full", "sm:w-64"]) {
			expect(realSearchClasses).toContain(c);
			expect(search?.classList).toContain(c);
		}
		expect(row.querySelectorAll('[data-part="facet"]')).toHaveLength(2);
		const action = row.querySelector('[data-part="action"]');
		const end = action?.parentElement;
		expect(end ? [...end.classList].sort() : []).toEqual(realEndClasses);
	});

	it("renders nothing when asked for nothing", () => {
		const { container } = render(<ListToolbarSkeleton search={false} />);
		expect(container).toBeEmptyDOMElement();
	});
});
