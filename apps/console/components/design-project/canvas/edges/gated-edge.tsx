"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	BaseEdge,
	EdgeLabelRenderer,
	getSmoothStepPath,
	type EdgeProps,
} from "@xyflow/react";

/**
 * Hot cross-cloud data-plane edge: drawn (the model is versatile) but flagged as
 * un-provisionable (provisioning is disciplined — gated until cross-cloud
 * networking lands). Dashed stroke + a mono roadmap tag.
 */
export function GatedEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
}: EdgeProps) {
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
				style={{
					stroke: "var(--muted-foreground, #888)",
					strokeWidth: 1.5,
					strokeDasharray: "4 4",
				}}
			/>
			<EdgeLabelRenderer>
				<div
					className="vx-eyebrow nodrag nopan pointer-events-none absolute border border-border bg-background px-1.5 py-0.5"
					style={{
						transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
					}}
				>
					On roadmap
				</div>
			</EdgeLabelRenderer>
		</>
	);
}
