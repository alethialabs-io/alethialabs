// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6320 (B2): Settings · Classification's skeleton draws the body the manager will draw.
//
// The manager has two bodies with no geometry in common — the blank slate (no dimensions: the
// explainer and the starter-template cards, full width) and the master/detail (the dimension rail
// and the selected dimension's detail pane). The route skeleton used to draw the master/detail
// unconditionally, so an org with no taxonomy watched a 291px detail pane become a 532px blank
// slate. These pin which body the skeleton picks from what the browser already holds, the counts
// it draws, and — rendering the real manager beside it — that the blank slate's frame and cards are
// the manager's own.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"classification.dimensions": async () => [],
			"classification.canEdit": async () => true,
			"classification.dimensionBreakdown": async () => [],
		}).orpc,
	};
});
vi.mock("@/app/server/actions/classification/dimensions", () => ({
	createDimension: vi.fn(),
	updateDimension: vi.fn(),
	deleteDimension: vi.fn(),
	reorderDimensions: vi.fn(),
	createValue: vi.fn(),
	updateValue: vi.fn(),
	deleteValue: vi.fn(),
	reorderValues: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/classification",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({ org: "acme" }),
}));

import { ClassificationManager } from "@/components/classification/classification-manager";
import { ClassificationSkeleton } from "@/components/classification/classification-skeleton";
import { CLASSIFICATION_TEMPLATES } from "@/components/classification/classification-templates";

const DIMENSIONS_KEY = [["classification", "dimensions"], { input: {}, type: "query" }];
const CAN_EDIT_KEY = [["classification", "canEdit"], { input: undefined, type: "query" }];

/** A cached dimension with `values` values, carried by `resourceCount` resources. */
function dimension(id: string, values: number, resourceCount: number) {
	return {
		id,
		key: id,
		label: id,
		description: null,
		multi: false,
		position: 0,
		appliesTo: [],
		resourceCount,
		values: Array.from({ length: values }, (_, i) => ({ id: `${id}-v${i}`, value: `v${i}`, label: `V${i}`, assignmentCount: 0 })),
	};
}

/** Renders under a client whose cache holds `cache` (key → data). */
function renderWith(ui: ReactElement, cache: Array<[unknown[], unknown]> = []) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	for (const [key, data] of cache) client.setQueryData(key, data);
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ClassificationSkeleton (#6320, B2)", () => {
	it("draws the blank slate — one card per starter template — when the browser holds no taxonomy", () => {
		const { container } = renderWith(<ClassificationSkeleton />);
		const blank = screen.getByTestId("classification-skeleton-blank");
		expect(blank.querySelectorAll(".grid > div")).toHaveLength(CLASSIFICATION_TEMPLATES.length);
		// No master/detail: no rail, no detail pane.
		expect(container.querySelector(".lg\\:grid-cols-\\[296px_1fr\\]")).toBeNull();
	});

	it("draws the blank slate without template cards for a viewer who cannot edit", () => {
		renderWith(<ClassificationSkeleton />, [[CAN_EDIT_KEY, false]]);
		expect(screen.getByTestId("classification-skeleton-blank").querySelectorAll(".grid > div")).toHaveLength(0);
	});

	it("draws the master/detail with the cached counts when the browser holds a taxonomy", () => {
		const { container } = renderWith(<ClassificationSkeleton />, [
			[DIMENSIONS_KEY, [dimension("env", 3, 0), dimension("team", 5, 2)]],
			[CAN_EDIT_KEY, true],
		]);
		expect(screen.queryByTestId("classification-skeleton-blank")).toBeNull();
		const grid = container.querySelector(".lg\\:grid-cols-\\[296px_1fr\\]");
		expect(grid).not.toBeNull();
		const [rail, detail] = Array.from(grid?.children ?? []);
		// The rail: its header, then one row per dimension.
		expect(rail?.children).toHaveLength(1 + 2);
		// The detail pane opens on the FIRST dimension: header, values block, coverage one-liner
		// (nothing carries it). The values block: its header, three rows, the add-value row.
		expect(detail?.children).toHaveLength(3);
		expect(detail?.children[1]?.children).toHaveLength(1 + 3 + 1);
	});

	it("draws the blank slate in the manager's own frame and cards", async () => {
		renderWith(<ClassificationSkeleton />);
		const skeleton = screen.getByTestId("classification-skeleton-blank");
		const view = renderWith(<ClassificationManager />, [
			[DIMENSIONS_KEY, []],
			[CAN_EDIT_KEY, true],
		]);
		const heading = await view.findByText("Start your taxonomy");
		const frame = heading.closest(".border-dashed");
		expect(frame).not.toBeNull();
		expect(skeleton.className).toBe(frame?.className);
		const realCards = Array.from(frame?.querySelectorAll(".grid > div") ?? []);
		const skeletonCards = Array.from(skeleton.querySelectorAll(".grid > div"));
		expect(skeletonCards.map((c) => c.className)).toEqual(realCards.map((c) => c.className));
	});
});
