// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { elkLayout } from "@/lib/canvas/auto-layout";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** The subset of React Flow's `fitView` the arrange step needs. */
export type FitView = (opts?: { padding?: number; duration?: number }) => unknown;

/**
 * Auto-arrange the board (elkjs) and frame the result. Lays out the DESIGN nodes — the hidden
 * project/cluster/network are the implicit substrate, not part of the graph — commits the
 * positions as one undo step, then fits the view so the tidied board is framed. A manual drag
 * afterwards overrides until the next arrange.
 *
 * One function, three callers: the canvas's ⋯ menu, the pane context menu and the ⌘K palette.
 * It used to live inside the controls bar, which was the only place you could ask for it.
 */
export async function arrangeBoard(fitView: FitView): Promise<void> {
	const s = useCanvasStore.getState();
	const layoutNodes = s.nodes.filter(
		(n) =>
			n.data.kind !== "project" &&
			n.data.kind !== "cluster" &&
			n.data.kind !== "network",
	);
	const positions = await elkLayout(
		layoutNodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
		s.edges,
	);
	s.arrange(positions);
	requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
}
