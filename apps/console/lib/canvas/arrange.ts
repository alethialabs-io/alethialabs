// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { elkLayout } from "@/lib/canvas/auto-layout";
import type { Board } from "@/lib/canvas/store/board";
import { deriveEdges } from "@/lib/canvas/store/derive";

/** The subset of React Flow's `fitView` the arrange step needs. */
export type FitView = (opts?: { padding?: number; duration?: number }) => unknown;

/**
 * Auto-arrange the board (elkjs) and frame the result. Lays out the DESIGN nodes — the hidden
 * project/cluster/network are the implicit substrate, not part of the graph — and the cards beside
 * them (`others`, the cards the design does not own), commits the positions as one undo step, then
 * fits the view so the tidied board is framed. A manual drag afterwards overrides until the next
 * arrange.
 *
 * One function, three callers: the canvas's ⋯ menu, the pane context menu and the ⌘K palette.
 * It used to live inside the controls bar, which was the only place you could ask for it.
 */
export async function arrangeBoard(
	board: Board,
	others: CanvasNode[],
	fitView: FitView,
): Promise<void> {
	const nodes = board.nodes(others);
	const layoutNodes = nodes.filter(
		(n) =>
			n.data.kind !== "project" &&
			n.data.kind !== "cluster" &&
			n.data.kind !== "network",
	);
	const positions = await elkLayout(
		layoutNodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
		deriveEdges(nodes),
	);
	board.document.getState().arrange(positions);
	requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
}
