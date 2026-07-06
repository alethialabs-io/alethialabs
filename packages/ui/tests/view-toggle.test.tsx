// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the card/table ViewToggle: the active mode is reflected via
// aria-pressed, and clicking a mode reports it through onChange.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ViewToggle } from "../src/view-toggle";

describe("ViewToggle", () => {
	it("marks the active mode with aria-pressed", () => {
		render(<ViewToggle value="card" onChange={() => {}} />);
		expect(screen.getByRole("button", { name: /card view/i })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: /table view/i })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("reports the chosen mode through onChange", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<ViewToggle value="card" onChange={onChange} />);

		await user.click(screen.getByRole("button", { name: /table view/i }));
		expect(onChange).toHaveBeenCalledWith("table");

		await user.click(screen.getByRole("button", { name: /card view/i }));
		expect(onChange).toHaveBeenCalledWith("card");
	});
});
