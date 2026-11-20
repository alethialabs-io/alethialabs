"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { BoardEdge } from "./board-edges";
import { EdgeSelectionLabel } from "./edge-selection-label";

/**
 * Dotted "consumes" edge (W5 Path A): a described chart workload → a backing resource it binds to.
 * Grayscale and dashed so it reads as a soft dependency — the workload is described, not owned by
 * the design — distinct from the solid infrastructure `dependency` edge. (When the W3 service
 * binding-edge lane lands its own generic edge, this can be unified with it.)
 */
export function ChartBindingEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
	id,
	selected,
	data,
}: EdgeProps<BoardEdge>) {
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});
	// A selected line is the same dotted line, heavier and in full ink: selection is read by weight,
	// never by a hue. The 24px interaction path is what makes a hairline something a pointer can hit.
	return (
		<>
			<BaseEdge
				path={path}
				markerEnd={markerEnd}
				interactionWidth={24}
				style={{
					stroke: selected ? "var(--foreground, #111)" : "var(--border-strong, #a3a3a3)",
					strokeWidth: selected ? 2.5 : 1.5,
					strokeDasharray: "2 3",
				}}
			/>
			{selected && <EdgeSelectionLabel edgeId={id} x={labelX} y={labelY} data={data} />}
		</>
	);
}
