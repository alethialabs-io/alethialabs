// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819: the clusters routes' loading state. It is SYNCHRONOUS — it reads nothing, so nothing paints
// before it (the skeleton rules, docs/ui-conformance/RUBRIC.md) — and it is the list's own shape:
// the toolbar, the list's real filter bar, and a table with the route's column count. The org route
// has a Project column; a project's own route does not.

import { render } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import ProjectClustersLoading from "@/app/(private)/[org]/[project]/clusters/loading";
import ClustersLoading from "@/app/(private)/[org]/~/clusters/loading";
import { clusterColumnCount } from "@/components/clusters/cluster-columns";
import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/** The skeleton's root in `container`. */
function root(container: HTMLElement): Element {
	const el = container.querySelector('[data-skeleton="clusters"]');
	if (!el) throw new Error("the clusters skeleton did not render");
	return el;
}

describe("the clusters routes' loading.tsx", () => {
	it("is synchronous: each returns an element, not a promise", () => {
		expect(isValidElement(ClustersLoading())).toBe(true);
		expect(isValidElement(ProjectClustersLoading())).toBe(true);
	});

	it("the org route draws the list with its Project column", () => {
		const { container } = render(ClustersLoading());
		expect(root(container).querySelectorAll("th")).toHaveLength(clusterColumnCount(true));
		expect(clusterColumnCount(true)).toBe(6);
	});

	it("a project's route draws the list without it", () => {
		const { container } = render(ProjectClustersLoading());
		expect(root(container).querySelectorAll("th")).toHaveLength(clusterColumnCount(false));
		expect(clusterColumnCount(false)).toBe(5);
	});
});

describe("ClustersSkeleton", () => {
	it("says the region is pending, and cannot be operated", () => {
		const { container } = render(<ClustersSkeleton />);
		const el = root(container);
		expect(el).toHaveAttribute("aria-busy", "true");
		expect(el).toHaveAttribute("data-slot", "skeleton-root");
		expect(el).toHaveAttribute("inert");
	});

	it("draws the toolbar, the list's own filter bar and the table — in that order", () => {
		const { container } = render(<ClustersSkeleton />);
		const el = root(container);
		expect(el.querySelector('[data-slot="page-toolbar-skeleton"]')).not.toBeNull();
		// The bar is the real one, at its defaults: its search box is there, with nothing typed.
		const search = el.querySelector('input[aria-label="Search clusters"]');
		expect(search).not.toBeNull();
		expect(search).toHaveValue("");
		expect(el.querySelector('[data-slot="data-table-skeleton"]')).not.toBeNull();
		const order = [...el.children].map((child) => child.getAttribute("data-slot"));
		expect(order.indexOf("page-toolbar-skeleton")).toBeLessThan(order.indexOf("data-table-skeleton"));
	});

	it("is never a spinner", () => {
		const { container } = render(<ClustersSkeleton />);
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});
