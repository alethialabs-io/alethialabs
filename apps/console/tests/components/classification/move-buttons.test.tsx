// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F-29: the keyboard reorder's order arithmetic and its end-of-list arrows.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoveButtons, movedBy } from "@/components/classification/move-buttons";

describe("movedBy", () => {
	it("moves one place up or down", () => {
		expect(movedBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
		expect(movedBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
	});

	it("leaves the order alone past either end, or for an unknown id", () => {
		expect(movedBy(["a", "b"], "a", -1)).toEqual(["a", "b"]);
		expect(movedBy(["a", "b"], "b", 1)).toEqual(["a", "b"]);
		expect(movedBy(["a", "b"], "z", 1)).toEqual(["a", "b"]);
	});
});

describe("MoveButtons", () => {
	it("names both arrows after the row and disables the one with nowhere to go", async () => {
		const user = userEvent.setup();
		const down = vi.fn();
		render(<MoveButtons label="Team" onMoveDown={down} />);
		expect(screen.getByRole("button", { name: "Move Team up" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Move Team down" }));
		expect(down).toHaveBeenCalledTimes(1);
	});
});
