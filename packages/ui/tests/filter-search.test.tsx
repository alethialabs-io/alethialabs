// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterSearch input: controlled value round-trip and the
// placeholder-as-accessible-name fallback.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterSearch } from "../src/filter-search";

/** Stateful harness so the controlled input actually accepts typing. */
function Harness({ onChange }: { onChange: (v: string) => void }) {
	const [value, setValue] = useState("");
	return (
		<FilterSearch
			value={value}
			onChange={(v) => {
				setValue(v);
				onChange(v);
			}}
			placeholder="Filter by project…"
		/>
	);
}

describe("FilterSearch", () => {
	it("uses the placeholder as the accessible name by default", () => {
		render(<FilterSearch value="" onChange={() => {}} placeholder="Filter by project…" />);
		expect(screen.getByLabelText("Filter by project…")).toBeInTheDocument();
	});

	it("prefers an explicit ariaLabel", () => {
		render(
			<FilterSearch
				value=""
				onChange={() => {}}
				placeholder="Filter…"
				ariaLabel="Search environments"
			/>,
		);
		expect(screen.getByLabelText("Search environments")).toBeInTheDocument();
	});

	it("round-trips typed input through onChange", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const input = screen.getByLabelText("Filter by project…");
		await user.type(input, "api");
		expect(input).toHaveValue("api");
		expect(onChange).toHaveBeenLastCalledWith("api");
	});
});
