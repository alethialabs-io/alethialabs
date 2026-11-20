"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { BoardEdge } from "./board-edges";
import { EdgeSelectionLabel } from "./edge-selection-label";

/** Solid hairline dependency edge (network→cluster, cluster→resource). */
export function DependencyEdge({
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
	return (
		<>
			<BaseEdge
				path={path}
				markerEnd={markerEnd}
				interactionWidth={24}
				style={{
					stroke: selected ? "var(--foreground, #111)" : "var(--border, #d4d4d4)",
					strokeWidth: selected ? 2.5 : 1.5,
				}}
			/>
			{selected && <EdgeSelectionLabel edgeId={id} x={labelX} y={labelY} data={data} />}
		</>
	);
}
