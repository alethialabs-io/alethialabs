// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Vendor-drift guard for the shadcn `marker` component (components/ui/marker.tsx): the
// transcript relies on its data-slot/data-variant contract, the separator hairlines, and
// the decorative (aria-hidden) icon slot — assert those so an upstream re-vendor that
// changes them fails loudly.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";

describe("Marker", () => {
	it("renders the marker slot with the default variant", () => {
		render(
			<Marker data-testid="m">
				<MarkerContent>system note</MarkerContent>
			</Marker>,
		);
		const marker = screen.getByTestId("m");
		expect(marker).toHaveAttribute("data-slot", "marker");
		expect(marker).toHaveAttribute("data-variant", "default");
		expect(screen.getByText("system note")).toBeInTheDocument();
	});

	it("carries the hairline pseudo-element classes on the separator variant", () => {
		render(
			<Marker data-testid="m" variant="separator">
				<MarkerContent>plan</MarkerContent>
			</Marker>,
		);
		const marker = screen.getByTestId("m");
		expect(marker).toHaveAttribute("data-variant", "separator");
		expect(marker.className).toContain("before:bg-border");
		expect(marker.className).toContain("after:bg-border");
	});

	it("carries the bottom hairline on the border variant", () => {
		render(<Marker data-testid="m" variant="border" />);
		expect(screen.getByTestId("m").className).toContain("border-b");
	});

	it("hides the icon slot from assistive tech", () => {
		render(
			<Marker>
				<MarkerIcon data-testid="icon">·</MarkerIcon>
				<MarkerContent>note</MarkerContent>
			</Marker>,
		);
		expect(screen.getByTestId("icon")).toHaveAttribute("aria-hidden", "true");
	});

	it("merges call-site classes (call sites own sizing/typography)", () => {
		render(
			<Marker data-testid="m" className="font-mono text-[10px]">
				<MarkerContent>sized</MarkerContent>
			</Marker>,
		);
		expect(screen.getByTestId("m").className).toContain("font-mono");
	});
});
