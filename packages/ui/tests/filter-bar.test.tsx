// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterBar shell + FilterBarReset: slot rendering and the
// hidden-at-zero / visible-with-count reset contract.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar, FilterBarReset } from "../src/filter-bar";

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
});
