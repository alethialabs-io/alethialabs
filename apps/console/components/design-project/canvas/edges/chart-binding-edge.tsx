"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

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
				stroke: "var(--border-strong, #a3a3a3)",
				strokeWidth: 1.5,
				strokeDasharray: "2 3",
			}}
		/>
	);
}
