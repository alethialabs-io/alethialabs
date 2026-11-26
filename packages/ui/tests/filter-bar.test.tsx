// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterBar shell + FilterBarReset + FilterEmpty: slot rendering, the
// hidden-at-zero / visible-with-count reset contract, and the empty FILTERED result (#7737).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar, FilterBarReset, FilterEmpty } from "../src/filter-bar";

describe("FilterBar", () => {
	it("renders children in order and the end slot right-aligned", () => {
		render(
			<FilterBar end={<button type="button">Export</button>}>
				<input aria-label="Search" />
				<button type="button">Status</button>
			</FilterBar>,
		);
		expect(screen.getByLabelText("Search")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
		const end = screen.getByRole("button", { name: "Export" });
		expect(end.parentElement?.className).toContain("ml-auto");
	});

	it("omits the end wrapper when no end content is given", () => {
		const { container } = render(
			<FilterBar>
				<span>child</span>
			</FilterBar>,
		);
		expect(container.querySelector(".ml-auto")).toBeNull();
	});
});

describe("FilterBarReset", () => {
	it("hides at zero active filters", () => {
		const { container } = render(<FilterBarReset count={0} onReset={() => {}} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the count and fires onReset", async () => {
		const user = userEvent.setup();
		const onReset = vi.fn();
		render(<FilterBarReset count={3} onReset={onReset} />);
		const btn = screen.getByRole("button", { name: /reset · 3/i });
		await user.click(btn);
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it("is mono, uppercase and tracked at 0.14em", () => {
		render(<FilterBarReset count={1} onReset={() => {}} />);
		const btn = screen.getByRole("button", { name: /reset · 1/i });
		expect(btn.className).toContain("font-mono");
		expect(btn.className).toContain("uppercase");
		expect(btn.className).toContain("tracking-[0.14em]");
	});
});

describe("FilterEmpty", () => {
	it("says no <noun> match these filters and offers Clear filters", async () => {
		const user = userEvent.setup();
		const onClear = vi.fn();
		const { container } = render(<FilterEmpty noun="runners" onClear={onClear} />);
		expect(screen.getByText("No runners match these filters.")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(onClear).toHaveBeenCalledTimes(1);
		// Built on the shared EmptyState, marked as its filtered variant.
		const root = container.querySelector('[data-slot="empty"]');
		expect(root).toHaveAttribute("data-variant", "filtered");
	});

	it("renders a real heading when given a level", () => {
		render(<FilterEmpty noun="jobs" onClear={() => {}} level={3} />);
		expect(screen.getByRole("heading", { level: 3, name: "No jobs match these filters." })).toBeInTheDocument();
	});
});
