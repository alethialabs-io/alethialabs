// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6349 (RUBRIC B2): the clusters skeleton draws the empty state's frame, the page an organization
// has until its first deploy succeeds. It drew two cluster cards side by side; on an organization
// with no clusters those 288px cards stood where the page centres its empty state (score 0.040
// against the 0.02 budget, two columns over none). Both cluster routes render it: the org page's
// `loading.tsx`, and the project page's, which re-exports it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/query/use-clusters-query", () => ({
	useClustersQuery: () => ({ data: [], isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/clusters/cluster-card", () => ({ ClusterCard: () => null }));

import ProjectClustersLoading from "@/app/(private)/[org]/[project]/clusters/loading";
import { ClustersClient } from "@/app/(private)/[org]/~/clusters/clusters-client";
import ClustersLoading from "@/app/(private)/[org]/~/clusters/loading";
import { CLUSTERS_REGION, ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/** The skeleton's root element. */
function skeletonRoot(container: HTMLElement): HTMLElement {
	const root = container.firstElementChild;
	if (!(root instanceof HTMLElement)) throw new Error("the skeleton rendered no root element");
	return root;
}

describe("ClustersSkeleton — the empty state's frame", () => {
	it("says it is loading, and never reads as the empty state itself", () => {
		const { container } = render(<ClustersSkeleton />);
		const root = skeletonRoot(container);
		expect(root.getAttribute("aria-busy")).toBe("true");
		expect(container.querySelector('[data-slot="empty"]')).toBeNull();
		expect(container.textContent).toBe("");
	});

	it("fills the same frame as the empty state that replaces it — the same classes, the same region", () => {
		const skeleton = render(<ClustersSkeleton />);
		const frame = skeletonRoot(skeleton.container).className;
		skeleton.unmount();

		const empty = render(<ClustersClient />).container.querySelector('[data-slot="empty"]');
		expect(empty).not.toBeNull();
		expect(frame).toBe(empty?.className);
		expect(frame.split(" ")).toContain(CLUSTERS_REGION);
	});

	it("draws the empty state's parts: the icon tile, a title line, two description lines and one action", () => {
		const { container } = render(<ClustersSkeleton />);
		expect(container.querySelectorAll('[data-slot="empty-icon"]')).toHaveLength(1);
		const title = container.querySelector('[data-slot="empty-title"]');
		expect(title?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
		const description = container.querySelector('[data-slot="empty-description"]');
		expect(description?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
		const action = container.querySelector('[data-slot="empty-content"]');
		expect(action?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
	});

	it("draws no cluster cards: no grid, no bordered frames side by side", () => {
		const { container } = render(<ClustersSkeleton />);
		expect(container.querySelector('[class*="grid-cols"]')).toBeNull();
		expect(container.querySelector(".border, .rounded-lg.border")).toBeNull();
	});

	it("is what both cluster routes paint while they prefetch", () => {
		const expected = render(<ClustersSkeleton />).container.innerHTML;
		expect(render(<ClustersLoading />).container.innerHTML).toBe(expected);
		expect(render(<ProjectClustersLoading />).container.innerHTML).toBe(expected);
	});
});
