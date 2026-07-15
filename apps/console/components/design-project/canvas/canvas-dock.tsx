"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inline docked side panel for the node inspector, shared by the project shell (persistent,
// across all project views) and the standalone create-flow canvas. The AI assistant is no longer
// docked here — it moved to the global Elench overlay surface (modal / floating panel), so this
// dock is now inspector-only. The inspector is canvas-only (Architecture view).

import { motion } from "motion/react";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { InspectorPanel } from "./node-inspector";

/** Docked panel geometry: the bordered panel width + the gap between it and the canvas. */
export const PANEL_W = 392;
export const PANEL_GAP = 12;

export type DockContent = "inspector" | null;

/**
 * Which panel the dock should show. `inspectorAllowed` gates the (canvas-only) inspector —
 * false on non-Architecture views. The AI assistant is a separate global overlay now.
 */
export function useDockState(inspectorAllowed: boolean): DockContent {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	return inspectorAllowed && inspectorNodeId ? "inspector" : null;
}

/** The bordered, width-animated dock. Width → 0 when closed. */
export function CanvasDock({
	dock,
	onDestroyEnvironment,
}: {
	dock: DockContent;
	projectId?: string;
	onDestroyEnvironment?: () => void;
}) {
	return (
		<motion.div
			initial={false}
			animate={{ width: dock ? PANEL_W + PANEL_GAP : 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="h-full shrink-0 overflow-hidden"
		>
			<div className="h-full pl-3" style={{ width: PANEL_W + PANEL_GAP }}>
				{/* NO top border: the panel sits flush under the topbar (whose own `border-b` is the top
				    line), so a `border-t` here would stack with it into a 2px seam. Left/right/bottom
				    only — the topbar owns the top edge, exactly as the board pane beside it does. */}
				<div
					className="flex h-full flex-col overflow-hidden rounded-none border-x border-b border-border bg-background"
					style={{ width: PANEL_W }}
				>
					{dock === "inspector" && (
						<InspectorPanel onDestroyEnvironment={onDestroyEnvironment} />
					)}
				</div>
			</div>
		</motion.div>
	);
}
