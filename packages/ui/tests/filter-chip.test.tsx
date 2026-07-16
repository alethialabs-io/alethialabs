// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterChip/FilterChipGroup toggle-filter primitives: pressed state
// via aria-pressed + filled styling, toggle reporting, the mono voice, custom render,
// the optional title, and the empty-options → null contract.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	FilterChip,
	FilterChipGroup,
	type FilterChipOption,
} from "../src/filter-chip";

const OPTIONS: FilterChipOption[] = [
	{ value: "production", label: "Production" },
	{ value: "staging", label: "Staging" },
	{ value: "development", label: "Development" },
];

describe("FilterChip", () => {
	it("reflects selection through aria-pressed and the filled style", () => {
		const { rerender } = render(
			<FilterChip on={false} onClick={() => {}}>
				Staging
			</FilterChip>,
		);
		const chip = screen.getByRole("button", { name: "Staging" });
		expect(chip).toHaveAttribute("aria-pressed", "false");
		expect(chip.className).not.toContain("bg-foreground");

		rerender(
			<FilterChip on onClick={() => {}}>
				Staging
			</FilterChip>,
		);
		expect(chip).toHaveAttribute("aria-pressed", "true");
		expect(chip.className).toContain("bg-foreground");
	});

	it("fires onClick and supports the mono voice", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(
			<FilterChip on={false} onClick={onClick} mono>
				v1.31
			</FilterChip>,
		);
		const chip = screen.getByRole("button", { name: "v1.31" });
		expect(chip.className).toContain("font-mono");
		await user.click(chip);
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("FilterChipGroup", () => {
	it("renders one chip per option and reports toggles by value", async () => {
		const user = userEvent.setup();
		const onToggle = vi.fn();
		render(
			<FilterChipGroup
				options={OPTIONS}
				selected={["staging"]}
				onToggle={onToggle}
				inline
			/>,
		);

		expect(screen.getAllByRole("button")).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Staging" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "Production" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);

		await user.click(screen.getByRole("button", { name: "Production" }));
		expect(onToggle).toHaveBeenCalledWith("production");
	});

	it("renders the mono uppercase title only when given", () => {
		const { rerender } = render(
			<FilterChipGroup
				title="Stage"
				options={OPTIONS}
				selected={[]}
				onToggle={() => {}}
			/>,
		);
		expect(screen.getByText("Stage")).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Stage" })).toBeInTheDocument();

		rerender(
			<FilterChipGroup options={OPTIONS} selected={[]} onToggle={() => {}} inline />,
		);
		expect(screen.queryByText("Stage")).not.toBeInTheDocument();
	});

	it("supports custom chip content through render", () => {
		render(
			<FilterChipGroup
				options={OPTIONS}
				selected={["production"]}
				onToggle={() => {}}
				render={(opt, on) => `${opt.label}${on ? " ✓" : ""}`}
			/>,
		);
		expect(screen.getByRole("button", { name: "Production ✓" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Staging" })).toBeInTheDocument();
	});

	it("renders nothing when there are no options", () => {
		const { container } = render(
			<FilterChipGroup options={[]} selected={[]} onToggle={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
