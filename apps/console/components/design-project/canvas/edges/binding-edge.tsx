"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

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
}: EdgeProps) {
	const [path] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});
	return (
		<BaseEdge
			path={path}
			markerEnd={markerEnd}
			style={{
				stroke: "var(--muted-foreground, #888)",
				strokeWidth: 1.5,
				strokeDasharray: "1 4",
			}}
		/>
	);
}
