// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Contract locks for the two error renders, moved here with the files from
// apps/console/components/errors/ (#7734):
// - `ErrorState`, the route-level surface for 404s and error boundaries (#707);
// - `RegionError`, the error render of one data region: announced, distinct from an empty state,
//   and always with a retry, which the type requires (#6117).
// Where each may be used is the console's rule, and stays in the console:
// apps/console/tests/components/errors/error-state-placement.test.tsx.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErrorState } from "../src/error-state";
import { RegionError } from "../src/region-error";

describe("ErrorState", () => {
	it("renders the title as the heading, plus code, description and actions when given", () => {
		render(
			<ErrorState
				code="500"
				title="Couldn't load clusters"
				description="Something went wrong."
				actions={<button type="button">Retry</button>}
			/>,
		);
		expect(screen.getByRole("heading", { level: 1, name: /Couldn't load clusters/i })).toBeInTheDocument();
		expect(screen.getByText("500")).toBeInTheDocument();
		expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});

	it("renders the title alone when optional fields are omitted", () => {
		render(<ErrorState title="Not found" />);
		expect(screen.getByRole("heading", { name: /Not found/i })).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("renders the mark slot, hidden from assistive technology, in the full-page layout", () => {
		const { container } = render(
			<ErrorState fullPage title="Page not found" mark={<svg data-testid="mark" />} />,
		);
		const slot = container.querySelector('[data-slot="error-state-mark"]');
		expect(slot).not.toBeNull();
		expect(slot?.getAttribute("aria-hidden")).toBe("true");
		expect(screen.getByTestId("mark")).toBeInTheDocument();
	});

	it("leaves the mark out of the in-shell panel, which sits under the shell's own branding", () => {
		const { container } = render(<ErrorState title="Not found" mark={<svg data-testid="mark" />} />);
		expect(container.querySelector('[data-slot="error-state-mark"]')).toBeNull();
		expect(screen.queryByTestId("mark")).toBeNull();
	});

	it("sets a bracketed code between the mark's two brackets, with the code as its own text", () => {
		const { container } = render(<ErrorState fullPage code="404" codeVariant="bracketed" title="Nothing here." />);
		const slot = container.querySelector('[data-slot="error-state-code"]');
		expect(slot).not.toBeNull();
		// The code is a text node of its own — the e2e specs find every 404 by this exact text.
		expect(screen.getByText("404", { exact: true }).closest('[data-slot="error-state-code"]')).toBe(slot);
		// Space Grotesk 600, at a display rung: the larger one full page, the shell one in a panel.
		expect(slot).toHaveClass("font-grotesk", "font-semibold", "text-display-sm");
		// The brackets are the mark's two paths, drawn and hidden from assistive technology.
		const brackets = slot?.querySelectorAll("svg") ?? [];
		expect(brackets).toHaveLength(2);
		for (const svg of brackets) expect(svg.getAttribute("aria-hidden")).toBe("true");
		expect(brackets[0]?.querySelector("path")?.getAttribute("d")).toBe("M11 6 H6.5 V26 H11");
		expect(brackets[1]?.querySelector("path")?.getAttribute("d")).toBe("M21 6 H25.5 V26 H21");
	});

	it("sets the bracketed code at the shell's display rung in the in-content panel", () => {
		const { container } = render(<ErrorState code="404" codeVariant="bracketed" title="Nothing here." />);
		expect(container.querySelector('[data-slot="error-state-code"]')).toHaveClass("text-display-xs");
	});

	it("keeps the mono code line, without brackets, when no variant is asked for", () => {
		const { container } = render(<ErrorState code="500" title="A" />);
		expect(container.querySelector('[data-slot="error-state-code"]')).toBeNull();
		expect(screen.getByText("500")).toHaveClass("font-mono");
		expect(container.querySelector("svg")).toBeNull();
	});

	it("keeps the layout literals the e2e T6 detector derives its signature from", () => {
		// apps/console/e2e/audit/error-state.ts reads this file's class literals carrying
		// `min-h-[320px]` / `min-h-screen` to recognise a rendered ErrorState.
		const panel = render(<ErrorState title="A" />);
		expect(panel.container.querySelector(".min-h-\\[320px\\]")).not.toBeNull();
		panel.unmount();
		const full = render(<ErrorState fullPage title="B" />);
		expect(full.container.querySelector(".min-h-screen")).not.toBeNull();
	});
});

describe("RegionError", () => {
	it("is an announced error state, not an empty state", () => {
		render(<RegionError onRetry={() => {}} />);
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-state")).toBe("error");
		expect(alert.getAttribute("data-slot")).toBe("region-error");
		expect(screen.getByText("Couldn't load this")).toBeInTheDocument();
	});

	it("always offers the retry, and calls it", () => {
		const onRetry = vi.fn();
		render(<RegionError title="Couldn't load jobs" onRetry={onRetry} />);
		expect(screen.getByText("Couldn't load jobs")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("refuses, at the type level, an error with nothing to retry", () => {
		// @ts-expect-error — `onRetry` is required: an error with no retry is a dead end.
		const el = <RegionError />;
		expect(el).toBeTruthy();
	});

	it("does not add a heading to the document outline", () => {
		render(<RegionError onRetry={() => {}} />);
		expect(screen.queryByRole("heading")).toBeNull();
	});
});
