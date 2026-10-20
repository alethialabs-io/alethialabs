// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RegionError is the error render of one data region: announced, distinct from an empty state,
// and with a retry only when there is something to retry (#6117).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RegionError } from "@/components/errors/region-error";

describe("RegionError", () => {
	it("is an announced error state, not an empty state", () => {
		render(<RegionError />);
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-state")).toBe("error");
		expect(alert.getAttribute("data-slot")).toBe("region-error");
		expect(screen.getByText("Couldn't load this")).toBeInTheDocument();
	});

	it("renders no retry without a handler, and calls it when there is one", () => {
		const { rerender } = render(<RegionError />);
		expect(screen.queryByRole("button")).toBeNull();
		const onRetry = vi.fn();
		rerender(<RegionError title="Couldn't load jobs" onRetry={onRetry} />);
		expect(screen.getByText("Couldn't load jobs")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("does not add a heading to the document outline", () => {
		render(<RegionError />);
		expect(screen.queryByRole("heading")).toBeNull();
	});
});
