"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { BoardEdge } from "./board-edges";
import { EdgeSelectionLabel } from "./edge-selection-label";

/**
 * A service→backing-resource binding edge (W3). Distinct from the structural dependency trunk
 * (cluster→leaf, solid) and the gated cross-cloud edge (dashed + roadmap tag): a fine DOTTED hairline
 * that reads as a logical "this workload consumes that resource" wire, not part of the placement
 * hierarchy. Grayscale like everything else — the relationship is carried by the line, not a hue.
 */
export function BindingEdge({
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
					stroke: selected ? "var(--foreground, #111)" : "var(--muted-foreground, #888)",
					strokeWidth: selected ? 2.5 : 1.5,
					strokeDasharray: "1 4",
				}}
			/>
			{selected && <EdgeSelectionLabel edgeId={id} x={labelX} y={labelY} data={data} />}
		</>
	);
}
