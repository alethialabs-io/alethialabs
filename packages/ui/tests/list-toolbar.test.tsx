// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ListToolbar owns the list page's filter row (#7734): it renders the pieces it is given in ONE
// order, pushes the page's controls to the far right, and its skeleton is the same row.
//
// jsdom does no layout, so nothing here measures a position. What it can read is DOM order, which
// is reading and tab order, and the classes that decide wrapping and right-alignment.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { FunnelFilter } from "../src/funnel-filter";
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
		// The trigger naming its selection is FacetFilter's own render, so the value reached it.
		expect(screen.getByRole("button", { name: /^Status/ })).toHaveAccessibleName("Status: Online");
	});

	it("passes the search's inputRef and shortcut through to FilterSearch (#7737)", () => {
		const ref = createRef<HTMLInputElement>();
		render(
			<ListToolbar
				search={{
					value: "",
					onChange: () => {},
					placeholder: "Search runners",
					inputRef: ref,
					shortcut: { hint: "/", ariaKeyShortcuts: "/" },
				}}
			/>,
		);
		const input = screen.getByRole("textbox", { name: "Search runners" });
		expect(ref.current).toBe(input);
		expect(input).toHaveAttribute("aria-keyshortcuts", "/");
	});

	it("draws no `/` hint when the page has not wired the shortcut", () => {
		const { container } = render(
			<ListToolbar search={{ value: "", onChange: () => {}, placeholder: "Search runners" }} />,
		);
		expect(screen.getByRole("textbox", { name: "Search runners" })).not.toHaveAttribute("aria-keyshortcuts");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toBeNull();
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
		const realSearch = screen.getByRole("textbox").closest('[data-slot="filter-search"]');
		const realSearchClasses = realSearch ? [...realSearch.classList] : [];
		real.unmount();

		const { container } = render(<ListToolbarSkeleton facets={2} actions={1} />);
		const row = slot(container, "list-toolbar-skeleton");
		expect(row.getAttribute("aria-hidden")).toBe("true");
		expect([...row.classList].sort()).toEqual(realClasses);
		const search = row.querySelector('[data-part="search"]');
		// The search placeholder carries the real search's width classes.
		for (const c of ["w-full", "sm:w-65"]) {
			expect(realSearchClasses).toContain(c);
			expect(search?.classList).toContain(c);
		}
		expect(row.querySelectorAll('[data-part="facet"]')).toHaveLength(2);
		const action = row.querySelector('[data-part="action"]');
		const end = action?.parentElement;
		expect(end ? [...end.classList].sort() : []).toEqual(realEndClasses);
	});

	it("draws the date-range part once for `true` and as many times as a count asks", () => {
		const one = render(<ListToolbarSkeleton dateRange />);
		expect(one.container.querySelectorAll('[data-part="date-range"]')).toHaveLength(1);
		one.unmount();
		const two = render(<ListToolbarSkeleton dateRange={2} />);
		expect(two.container.querySelectorAll('[data-part="date-range"]')).toHaveLength(2);
		two.unmount();
		const none = render(<ListToolbarSkeleton dateRange={false} />);
		expect(none.container.querySelectorAll('[data-part="date-range"]')).toHaveLength(0);
	});

	it("draws each extra part at its named size, after the facets and the range, in order", () => {
		const { container } = render(
			<ListToolbarSkeleton facets={1} dateRange extra={["control", "icon"]} actions={1} />,
		);
		const row = slot(container, "list-toolbar-skeleton");
		const parts = [...row.children].map((el) => el.getAttribute("data-part") ?? "end");
		expect(parts).toEqual(["search", "facet", "date-range", "extra", "extra", "end"]);
		const extras = [...row.querySelectorAll('[data-part="extra"]')];
		expect(extras.map((el) => el.getAttribute("data-size"))).toEqual(["control", "icon"]);
		// `control` is the facet's own box; `icon` is FunnelFilter's square `h-10 w-10` trigger.
		const facet = row.querySelector('[data-part="facet"]');
		expect([...(extras[0]?.classList ?? [])].sort()).toEqual([...(facet?.classList ?? [])].sort());
		expect(extras[1]?.classList).toContain("size-10");
	});

	it("draws `icon` as FunnelFilter's real trigger box: 40px square", () => {
		const real = render(<FunnelFilter facets={[]} selected={{}} onToggle={() => {}} onReset={() => {}} dirty={false} />);
		const trigger = real.getByRole("button");
		// Tailwind's `h-10 w-10` and `size-10` are both 2.5rem by 2.5rem.
		expect(trigger.classList).toContain("h-10");
		expect(trigger.classList).toContain("w-10");
		real.unmount();
		const { container } = render(<ListToolbarSkeleton search={false} extra="icon" />);
		expect(container.querySelector('[data-part="extra"]')?.classList).toContain("size-10");
	});

	it("takes a single extra size as one part", () => {
		const { container } = render(<ListToolbarSkeleton search={false} extra="icon" />);
		const extras = container.querySelectorAll('[data-part="extra"]');
		expect(extras).toHaveLength(1);
		expect(extras[0]?.getAttribute("data-size")).toBe("icon");
	});

	it("renders nothing when asked for nothing", () => {
		const { container } = render(<ListToolbarSkeleton search={false} />);
		expect(container).toBeEmptyDOMElement();
		const empty = render(<ListToolbarSkeleton search={false} dateRange={0} extra={[]} />);
		expect(empty.container).toBeEmptyDOMElement();
	});
});
