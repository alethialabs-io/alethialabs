// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819 (RUBRIC B2): the Environments skeleton is the page's own shape — the toolbar with its two
// actions, the list's real filter bar, and the table with its real column count and ONE row, the
// page every project has until it gets a second environment. Synchronous, pending to assistive
// tech, and not operable.

import { render } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import EnvironmentsLoading from "@/app/(private)/[org]/[project]/environments/loading";
import { ENVIRONMENT_COLUMN_COUNT } from "@/components/environments/environment-status";
import { EnvironmentsSkeleton } from "@/components/environments/environments-skeleton";

/** The skeleton's root in `container`. */
function root(container: HTMLElement): Element {
	const el = container.querySelector('[data-skeleton="environments"]');
	if (!el) throw new Error("the environments skeleton did not render");
	return el;
}

describe("EnvironmentsSkeleton", () => {
	it("the route's loading.tsx is synchronous and renders it", () => {
		const element = EnvironmentsLoading();
		expect(isValidElement(element)).toBe(true);
		const { container } = render(element);
		expect(root(container)).toBeTruthy();
	});

	it("says the region is pending, and cannot be operated", () => {
		const { container } = render(<EnvironmentsSkeleton />);
		expect(root(container)).toHaveAttribute("aria-busy", "true");
		expect(root(container)).toHaveAttribute("inert");
	});

	it("draws the toolbar, the list's own filter bar, and the table with one row", () => {
		const { container } = render(<EnvironmentsSkeleton />);
		const el = root(container);
		expect(el.querySelector('[data-slot="page-toolbar-skeleton"]')).not.toBeNull();
		expect(el.querySelector('input[aria-label="Search environments"]')).toHaveValue("");
		expect(el.querySelectorAll("th")).toHaveLength(ENVIRONMENT_COLUMN_COUNT);
		expect(el.querySelectorAll('[data-slot="data-table-skeleton-row"]')).toHaveLength(1);
	});

	it("is never a spinner", () => {
		const { container } = render(<EnvironmentsSkeleton />);
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});
