// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Fit view" on a board that draws nothing is a click that visibly does nothing — the R8 audit
// filed it inert on `[project]/architecture`, whose seeded board holds only the project, cluster
// and network nodes the canvas never draws (#4996). Every entry point now reads React Flow's DRAWN
// node count and, at zero, renders disabled with the reason as its title.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasCommandPalette } from "@/components/design-project/canvas/canvas-command-palette";
import { CanvasControls } from "@/components/design-project/canvas/canvas-controls";
import { CanvasMoreMenu } from "@/components/design-project/canvas/canvas-more-menu";
import { NOTHING_TO_FIT } from "@/components/design-project/canvas/use-has-drawn-nodes";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const flow = vi.hoisted(() => ({ drawn: 0, fitView: vi.fn() }));

vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	return {
		...actual,
		useReactFlow: () => ({ fitView: flow.fitView, zoomIn: vi.fn(), zoomOut: vi.fn() }),
		// The selector is the product's own; only the lookup it reads is the test's.
		useStore: <T,>(selector: (s: { nodeLookup: Map<string, unknown> }) => T): T =>
			selector({ nodeLookup: new Map(Array.from({ length: flow.drawn }, (_, i) => [`n${i}`, {}])) }),
	};
});

beforeEach(() => {
	useCanvasStore.getState().reset();
	flow.fitView.mockClear();
});

describe("Fit view on an empty board", () => {
	it("the controls bar disables it and says why", () => {
		flow.drawn = 0;
		render(<CanvasControls />);
		const fit = screen.getByRole("button", { name: "Fit view" });
		expect(fit).toBeDisabled();
		expect(fit).toHaveAttribute("title", NOTHING_TO_FIT);
	});

	it("the controls bar keeps it live once the board draws a node", async () => {
		flow.drawn = 1;
		const user = userEvent.setup();
		render(<CanvasControls />);
		const fit = screen.getByRole("button", { name: "Fit view" });
		expect(fit).toBeEnabled();
		expect(fit).toHaveAttribute("title", "Fit view");
		await user.click(fit);
		expect(flow.fitView).toHaveBeenCalledTimes(1);
	});

	it("the ⋯ menu disables its entry with the reason", async () => {
		flow.drawn = 0;
		const user = userEvent.setup();
		render(<CanvasMoreMenu iacGoverned={false} onShowShortcuts={vi.fn()} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		const item = await screen.findByRole("menuitem", { name: /fit view/i });
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(item).toHaveAttribute("title", NOTHING_TO_FIT);
	});

	it("the ⌘K palette disables its entry with the reason", () => {
		render(
			<CanvasCommandPalette
				open
				onOpenChange={vi.fn()}
				onFitView={flow.fitView}
				fitViewDisabled
				onAskAi={vi.fn()}
				onArrange={vi.fn()}
			/>,
		);
		const item = screen.getByText("Fit view").closest("[cmdk-item]");
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(item).toHaveAttribute("title", NOTHING_TO_FIT);
	});
});
