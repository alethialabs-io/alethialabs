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

	// #4197: the count is a named ink tier at full strength, never an alpha over the chip's
	// ink — at α=0.6 over the page background no foreground reaches 4.5:1. A filled chip is
	// inverted end to end, so there the count inherits the chip's `text-background`.
	it("renders the count as tertiary ink when resting and inherited ink when filled", () => {
		const { rerender } = render(
			<FilterChip on={false} onClick={() => {}} count={3}>
				Healthy
			</FilterChip>,
		);
		const count = screen.getByText("3");
		expect(count.className).toContain("text-text-tertiary");
		expect(count.className).toContain("font-mono");
		expect(count.className).not.toMatch(/opacity-|\/\d+/);
		expect(screen.getByRole("button", { name: "Healthy 3" })).toBeInTheDocument();

		rerender(
			<FilterChip on onClick={() => {}} count={3}>
				Healthy
			</FilterChip>,
		);
		expect(screen.getByText("3").className).not.toContain("text-text-tertiary");
	});

	it("renders no count node when none is given", () => {
		render(
			<FilterChip on={false} onClick={() => {}}>
				Healthy
			</FilterChip>,
		);
		expect(screen.getByRole("button", { name: "Healthy" }).childNodes).toHaveLength(1);
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

	it("passes an option's count through to its chip", () => {
		render(
			<FilterChipGroup
				options={[
					{ value: "healthy", label: "Healthy", count: 12 },
					{ value: "failed", label: "Failed", count: 0 },
					{ value: "unknown", label: "Unknown" },
				]}
				selected={[]}
				onToggle={() => {}}
				inline
			/>,
		);
		expect(screen.getByRole("button", { name: "Healthy 12" })).toBeInTheDocument();
		// A zero is a count, not an absence — it renders.
		expect(screen.getByRole("button", { name: "Failed 0" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Unknown" })).toBeInTheDocument();
	});

	it("renders nothing when there are no options", () => {
		const { container } = render(
			<FilterChipGroup options={[]} selected={[]} onToggle={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
