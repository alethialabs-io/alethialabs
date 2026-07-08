// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the extracted SuggestionCarousel: it windows the suggestions into
// pages of 3, the "Next suggestions" button cycles page 1→2→3→1 (wrap), the dot indicators
// reflect the active page via aria-current, and clicking a card fires onSelect(prompt).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Circle } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { ElenchSuggestion } from "@/components/agent/elench/elench-suggestions";
import { SuggestionCarousel } from "@/components/agent/elench/suggestion-carousel";

/** Nine fake suggestions ("S1".."S9") so the carousel fills three pages of three. */
const SUGGESTIONS: ElenchSuggestion[] = Array.from({ length: 9 }, (_, i) => ({
	icon: Circle,
	title: `S${i + 1}`,
	sub: `sub ${i + 1}`,
	prompt: `prompt ${i + 1}`,
}));

/** The card titles currently rendered (excludes the Next/dot control buttons). */
function visibleCardTitles(): string[] {
	return SUGGESTIONS.map((s) => s.title).filter((t) =>
		screen.queryByText(t) !== null,
	);
}

/** The 1-based index of the dot marked aria-current="true". */
function activeDotIndex(): number {
	const dots = screen
		.getAllByRole("button", { name: /suggestions page/i })
		.map((b) => b.getAttribute("aria-current"));
	return dots.findIndex((c) => c === "true") + 1;
}

describe("SuggestionCarousel", () => {
	it("shows exactly the first 3 cards on the initial page", () => {
		render(<SuggestionCarousel suggestions={SUGGESTIONS} onSelect={() => {}} />);
		expect(visibleCardTitles()).toEqual(["S1", "S2", "S3"]);
		expect(activeDotIndex()).toBe(1);
	});

	it("cycles pages 1→2→3→1 via the Next button, advancing the active dot", async () => {
		const user = userEvent.setup();
		render(<SuggestionCarousel suggestions={SUGGESTIONS} onSelect={() => {}} />);
		const next = screen.getByRole("button", { name: /next suggestions/i });

		await user.click(next);
		expect(visibleCardTitles()).toEqual(["S4", "S5", "S6"]);
		expect(activeDotIndex()).toBe(2);

		await user.click(next);
		expect(visibleCardTitles()).toEqual(["S7", "S8", "S9"]);
		expect(activeDotIndex()).toBe(3);

		// Wraps back to page 1.
		await user.click(next);
		expect(visibleCardTitles()).toEqual(["S1", "S2", "S3"]);
		expect(activeDotIndex()).toBe(1);
	});

	it("jumps directly to a page when its dot is clicked", async () => {
		const user = userEvent.setup();
		render(<SuggestionCarousel suggestions={SUGGESTIONS} onSelect={() => {}} />);
		await user.click(screen.getByRole("button", { name: /suggestions page 3/i }));
		expect(visibleCardTitles()).toEqual(["S7", "S8", "S9"]);
		expect(activeDotIndex()).toBe(3);
	});

	it("fires onSelect with the picked card's prompt", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(<SuggestionCarousel suggestions={SUGGESTIONS} onSelect={onSelect} />);
		await user.click(screen.getByRole("button", { name: /S2/ }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("prompt 2");

		// A card on a later page selects that page's prompt.
		await user.click(screen.getByRole("button", { name: /next suggestions/i }));
		await user.click(screen.getByRole("button", { name: /S5/ }));
		expect(onSelect).toHaveBeenLastCalledWith("prompt 5");
	});

	it("renders three page dots for the nine suggestions", () => {
		render(<SuggestionCarousel suggestions={SUGGESTIONS} onSelect={() => {}} />);
		const dots = screen.getAllByRole("button", { name: /suggestions page/i });
		expect(dots).toHaveLength(3);
		// Only the active dot carries aria-current="true".
		expect(dots.filter((d) => d.getAttribute("aria-current") === "true")).toHaveLength(1);
	});
});
