// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `SkeletonRoot` is the one wrapper a skeleton is drawn inside (CON-SM7, #6759 — rule 1 of "The
// skeleton rules" in docs/ui-conformance/RUBRIC.md).
//
// Skeleton roots used to disagree: some said `aria-busy`, some said `aria-hidden`. These pin the
// one statement the wrapper makes, and that a caller cannot unsay it.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

describe("SkeletonRoot", () => {
	it("marks the region busy, and names itself for a reader and a test", () => {
		render(<SkeletonRoot data-testid="root" />);
		const root = screen.getByTestId("root");
		expect(root.tagName).toBe("DIV");
		expect(root).toHaveAttribute("aria-busy", "true");
		expect(root).toHaveAttribute("data-slot", "skeleton-root");
	});

	it("is not hidden from assistive technology and takes no role", () => {
		render(<SkeletonRoot data-testid="root" />);
		const root = screen.getByTestId("root");
		expect(root).not.toHaveAttribute("aria-hidden");
		expect(root).not.toHaveAttribute("role");
	});

	it("leaves its children in the accessibility tree", () => {
		render(
			<SkeletonRoot>
				<button type="button">Invite</button>
			</SkeletonRoot>,
		);
		expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
	});

	it("passes layout through: className and other div attributes are the caller's", () => {
		render(<SkeletonRoot data-testid="root" className="space-y-5" id="members-skeleton" />);
		const root = screen.getByTestId("root");
		expect(root).toHaveClass("space-y-5");
		expect(root).toHaveAttribute("id", "members-skeleton");
	});

	it("keeps its own slot name when a caller passes one", () => {
		render(<SkeletonRoot data-testid="root" data-slot="billing-skeleton" />);
		expect(screen.getByTestId("root")).toHaveAttribute("data-slot", "skeleton-root");
	});

	it("is what a query for a pending region finds", () => {
		const { container } = render(
			<main>
				<SkeletonRoot />
			</main>,
		);
		// The selector `e2e/audit/filters.ts` reads to decide a page has not answered yet.
		expect(container.querySelector('main [aria-busy="true"]')).not.toBeNull();
	});
});
