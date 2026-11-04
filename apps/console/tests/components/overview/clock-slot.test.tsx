// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6118: the overview's cards render on the server, so text that reads the clock or the browser's
// zone must not be printed there — the server's "now" and zone are not the browser's (React #418).

import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClockSlot } from "@/components/overview/clock-slot";

describe("ClockSlot", () => {
	it("prints nothing of the clock on the server — only the invisible sizer", () => {
		const read = vi.fn(() => "3 minutes ago");
		const html = renderToString(<ClockSlot sizer="less than a minute ago" render={read} />);
		expect(html).toContain("less than a minute ago");
		expect(html).not.toContain("3 minutes ago");
		expect(read).not.toHaveBeenCalled();
	});

	it("prints the clock text once mounted in the browser", async () => {
		await act(async () => {
			render(<ClockSlot sizer="less than a minute ago" render={() => "3 minutes ago"} />);
		});
		expect(screen.getByText("3 minutes ago")).toBeInTheDocument();
	});
});
